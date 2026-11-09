import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WeComBotAdapter,
  type InboundEvent,
  type InboundMessage,
  type WebSocketLike,
  type WsEvent,
} from '../src/c2/adapters/wecom-bot.ts';
import { buildCard } from '../src/c2/message.ts';
import { makeDraft } from './helpers.ts';

type Listener = (...args: unknown[]) => void;

class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private listeners = new Map<WsEvent, Listener[]>();

  on(event: WsEvent, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  once(event: WsEvent, listener: Listener): void {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close', 1000);
  }

  emit(event: WsEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  private off(event: WsEvent, listener: Listener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    this.listeners.set(
      event,
      list.filter((item) => item !== listener),
    );
  }

  lastFrame(): Record<string, any> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? '{}');
  }

  respond(reqId: string, errcode = 0, errmsg = 'ok'): void {
    this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode, errmsg }));
  }
}

function expectFrame(ws: FakeWebSocket): Record<string, any> {
  return ws.lastFrame();
}

async function connected(): Promise<{ ws: FakeWebSocket; adapter: WeComBotAdapter }> {
  const ws = new FakeWebSocket();
  const adapter = new WeComBotAdapter(
    { botId: 'bot_1', secret: 'secret_1', wsFactory: () => ws },
    {},
  );
  const connectPromise = adapter.connect();
  ws.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  const subscribe = expectFrame(ws);
  assert.equal(subscribe.cmd, 'aibot_subscribe');
  assert.deepEqual(subscribe.body, { bot_id: 'bot_1', secret: 'secret_1' });
  ws.respond(subscribe.headers.req_id);
  await connectPromise;
  return { ws, adapter };
}

test('连接时发送订阅帧并在成功后 resolve', async () => {
  const { ws } = await connected();
  assert.equal(ws.sent.length, 1);
});

test('订阅失败时 connect 抛错', async () => {
  const ws = new FakeWebSocket();
  const adapter = new WeComBotAdapter(
    { botId: 'bot_1', secret: 'bad', wsFactory: () => ws },
    {},
  );
  const connectPromise = adapter.connect();
  ws.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  const subscribe = expectFrame(ws);
  ws.respond(subscribe.headers.req_id, 853000, 'invalid bot_id or secret');
  await assert.rejects(connectPromise, /SUBSCRIBE_FAILED 853000/);
});

test('sendCard 发 template_card，chatid=userid，chat_type=1', async () => {
  const { ws, adapter } = await connected();
  const card = buildCard(makeDraft({ id: 'd1' }), 1);

  const pending = adapter.sendCard('LiGuang', card);
  const frame = expectFrame(ws);
  assert.equal(frame.cmd, 'aibot_send_msg');
  assert.equal(frame.body.chatid, 'LiGuang');
  assert.equal(frame.body.chat_type, 1);
  assert.equal(frame.body.msgtype, 'template_card');
  assert.equal(frame.body.template_card.card_type, 'button_interaction');

  ws.respond(frame.headers.req_id);
  const res = await pending;
  assert.match(res.messageId, /^local_card_/);
});

test('sendText 用 markdown 承载纯文本', async () => {
  const { ws, adapter } = await connected();
  const pending = adapter.sendText('LiGuang', '这是正文');

  const frame = expectFrame(ws);
  assert.equal(frame.body.msgtype, 'markdown');
  assert.deepEqual(frame.body.markdown, { content: '这是正文' });

  ws.respond(frame.headers.req_id);
  const res = await pending;
  assert.match(res.messageId, /^local_text_/);
});

test('发送失败时抛错，交给队列重试', async () => {
  const { ws, adapter } = await connected();
  const pending = adapter.sendText('LiGuang', '正文');
  const frame = expectFrame(ws);
  ws.respond(frame.headers.req_id, 45009, 'api freq out of limit');
  await assert.rejects(pending, /SEND_TEXT_FAILED 45009/);
});

test('卡片 42014（task_id 已存在）按幂等视为已送达', async () => {
  const { ws, adapter } = await connected();
  const pending = adapter.sendCard('LiGuang', buildCard(makeDraft({ id: 'd1' }), 1));
  const frame = expectFrame(ws);
  assert.equal(frame.body.template_card.task_id.length > 0, true);
  ws.respond(frame.headers.req_id, 42014, 'taskid has existed');
  const res = await pending;
  assert.match(res.messageId, /^local_card_/);
});

test('aibot_msg_callback 解析单聊 userid 并作为 chatid', async () => {
  const received: InboundMessage[] = [];
  const ws = new FakeWebSocket();
  const adapter = new WeComBotAdapter(
    { botId: 'bot_1', secret: 'secret_1', wsFactory: () => ws },
    { onMessage: (message) => received.push(message) },
  );
  const connectPromise = adapter.connect();
  ws.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  ws.respond(expectFrame(ws).headers.req_id);
  await connectPromise;

  ws.emit(
    'message',
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'x' },
      body: {
        msgid: 'm1',
        chattype: 'single',
        from: { userid: 'LiGuang' },
        msgtype: 'text',
        text: { content: '测试' },
      },
    }),
  );

  assert.equal(received.length, 1);
  assert.equal(received[0].userid, 'LiGuang');
  assert.equal(received[0].chatid, 'LiGuang');
  assert.equal(received[0].chattype, 'single');
  assert.equal(received[0].text, '测试');
});

test('aibot_event_callback 取出 event_key 与 task_id', async () => {
  const received: InboundEvent[] = [];
  const ws = new FakeWebSocket();
  const adapter = new WeComBotAdapter(
    { botId: 'bot_1', secret: 'secret_1', wsFactory: () => ws },
    { onEvent: (event) => received.push(event) },
  );
  const connectPromise = adapter.connect();
  ws.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  ws.respond(expectFrame(ws).headers.req_id);
  await connectPromise;

  ws.emit(
    'message',
    JSON.stringify({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'x' },
      body: {
        chattype: 'single',
        from: { userid: 'LiGuang' },
        msgtype: 'event',
        event: {
          eventtype: 'template_card_event',
          template_card_event: {
            card_type: 'button_interaction',
            event_key: 'ack:draft_test:sent',
            task_id: 'task_1',
          },
        },
      },
    }),
  );

  assert.equal(received.length, 1);
  assert.equal(received[0].eventtype, 'template_card_event');
  assert.equal(received[0].eventKey, 'ack:draft_test:sent');
  assert.equal(received[0].taskId, 'task_1');
  assert.equal(received[0].userid, 'LiGuang');
});

test('#55 sendImage 用 aibot_send_msg + base64 + 原始字节 md5', async (t) => {
  const { ws, adapter } = await connected();
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-bot-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const path = join(dir, 'meal.jpg');
  await writeFile(path, data);

  const pending = adapter.sendImage('LiGuang', path);
  // readFile 走线程池，等发送帧真正写进 socket
  for (let i = 0; i < 100 && ws.sent.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const frame = expectFrame(ws);
  assert.equal(frame.cmd, 'aibot_send_msg');
  assert.equal(frame.body.chatid, 'LiGuang');
  assert.equal(frame.body.chat_type, 1);
  assert.equal(frame.body.msgtype, 'image');
  assert.equal(frame.body.image.base64, data.toString('base64'));
  assert.equal(frame.body.image.md5, createHash('md5').update(data).digest('hex'));

  ws.respond(frame.headers.req_id);
  const res = await pending;
  assert.match(res.messageId, /^local_image_/);
});

test('#55 sendImage 拒绝超限、非 JPG/PNG 与读不到的文件，错误不含路径', async (t) => {
  const { adapter } = await connected();
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-bot-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tooLarge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]);
  const largePath = join(dir, 'large.jpg');
  await writeFile(largePath, tooLarge);
  await assert.rejects(adapter.sendImage('LiGuang', largePath), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'SEND_IMAGE_TOO_LARGE');
    assert.equal(error.message.includes(dir), false);
    return true;
  });

  const gifPath = join(dir, 'note.gif');
  await writeFile(gifPath, Buffer.from('GIF89a'));
  await assert.rejects(adapter.sendImage('LiGuang', gifPath), /SEND_IMAGE_UNSUPPORTED/);

  const missing = join(dir, 'missing.jpg');
  await assert.rejects(adapter.sendImage('LiGuang', missing), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'SEND_IMAGE_READ_FAILED');
    assert.equal(error.message.includes(missing), false);
    return true;
  });
});
