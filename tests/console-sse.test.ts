/**
 * #41 SSE 通道单测：事件格式、租户隔离、types 前缀过滤、断线补发。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HttpRequestLike, HttpResponseLike } from '../plugins/zhiban-console/http.ts';
import { parseEventTypes, SseHub } from '../plugins/zhiban-console/sse.ts';

class FakeStreamResponse implements HttpResponseLike {
  headersSent = false;
  headers: Record<string, string | number> = {};
  chunks: string[] = [];
  ended = false;
  private closeHandler?: () => void;

  writeHead(status: number, headers: Record<string, string | number>): this {
    assert.equal(status, 200);
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(chunk.toString());
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.chunks.push(chunk.toString());
    this.ended = true;
    return this;
  }

  on(event: 'close' | 'error', listener: (...args: never[]) => void): this {
    if (event === 'close') this.closeHandler = listener as () => void;
    return this;
  }

  emitClose(): void {
    this.closeHandler?.();
  }

  text(): string {
    return this.chunks.join('');
  }
}

class FakeStreamRequest implements HttpRequestLike {
  headers: Record<string, string | string[] | undefined> = {};
  listeners = new Map<string, () => void>();

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, listener as () => void);
    return this;
  }

  get(path: string): string {
    return this.listeners.get(path)?.() ?? '';
  }
}

function open(hub: SseHub, options: { tenantId?: string; types?: string[]; lastEventId?: string } = {}) {
  const req = new FakeStreamRequest();
  const res = new FakeStreamResponse();
  const close = hub.open(req, res, {
    tenantId: options.tenantId ?? 'tn_a',
    types: options.types ?? [],
    lastEventId: options.lastEventId,
  });
  return { req, res, close };
}

test('parseEventTypes 拆分逗号并丢弃空项', () => {
  assert.deepEqual(parseEventTypes('draft.*, alert.created ,,sandbox.*'), [
    'draft.*',
    'alert.created',
    'sandbox.*',
  ]);
  assert.deepEqual(parseEventTypes(null), []);
  assert.deepEqual(parseEventTypes('  '), []);
});

test('open 写 SSE 头与 connected 注释，publish 按租户与类型过滤', () => {
  const hub = new SseHub();
  const { res } = open(hub, { types: ['draft.*'] });
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(res.text(), ': connected\n\n');
  assert.equal(hub.size, 1);

  hub.publish('draft.created', { draftId: 'd1' }, { tenantId: 'tn_a' });
  hub.publish('alert.created', { alertId: 'a1' }, { tenantId: 'tn_a' });
  hub.publish('draft.created', { draftId: 'd2' }, { tenantId: 'tn_b' });

  const text = res.text();
  assert.equal(text.includes('event: draft.created'), true);
  assert.equal(text.includes('"draftId":"d1"'), true);
  assert.equal(text.includes('alert.created'), false);
  assert.equal(text.includes('"draftId":"d2"'), false);
  assert.match(text, /id: evt_[a-f0-9]{24}\n/);
  assert.match(text, /data: \{"id":"evt_[a-f0-9]{24}","type":"draft\.created"/);
});

test('sandbox 标记与 types 为空时接收全部事件', () => {
  const hub = new SseHub();
  const { res } = open(hub);
  hub.publish('sandbox.draft', { draftId: 'sd1' }, { tenantId: 'tn_a', sandbox: true });
  const [dataLine] = res.text().split('\n').filter((line) => line.startsWith('data: '));
  const envelope = JSON.parse(dataLine!.slice('data: '.length)) as {
    sandbox: boolean;
    type: string;
  };
  assert.equal(envelope.sandbox, true);
  assert.equal(envelope.type, 'sandbox.draft');
});

test('Last-Event-ID 只补发其后的事件，并按租户/类型过滤', () => {
  const hub = new SseHub();
  const first = hub.publish('draft.created', { n: 1 }, { tenantId: 'tn_a' });
  const second = hub.publish('draft.created', { n: 2 }, { tenantId: 'tn_a' });
  hub.publish('draft.created', { n: 3 }, { tenantId: 'tn_b' });
  const third = hub.publish('alert.created', { n: 4 }, { tenantId: 'tn_a' });
  const fourth = hub.publish('draft.updated', { n: 5 }, { tenantId: 'tn_a' });

  const { res } = open(hub, { lastEventId: first.id, types: ['draft.*'] });
  const text = res.text();
  assert.equal(text.includes(`"n":2`), true);
  assert.equal(text.includes(`"n":3`), false);
  assert.equal(text.includes(`"n":4`), false);
  assert.equal(text.includes(`"n":5`), true);
  assert.equal(text.includes(first.id), false);
  assert.ok(second.id);
  assert.ok(third.id);
  assert.ok(fourth.id);
});

test('未知 Last-Event-ID 从头补发窗口内的当前租户事件', () => {
  const hub = new SseHub();
  hub.publish('draft.created', { n: 1 }, { tenantId: 'tn_a' });
  hub.publish('draft.created', { n: 2 }, { tenantId: 'tn_b' });
  const { res } = open(hub, { lastEventId: 'evt_missing' });
  const text = res.text();
  assert.equal(text.includes('"n":1'), true);
  assert.equal(text.includes('"n":2'), false);
});

test('关闭函数与 res close 事件都会移除客户端，不再推送', () => {
  const hub = new SseHub();
  const first = open(hub);
  const second = open(hub);
  assert.equal(hub.size, 2);

  first.close();
  assert.equal(hub.size, 1);
  assert.equal(first.res.ended, true);
  hub.publish('alert.created', {}, { tenantId: 'tn_a' });
  assert.equal(first.res.text().includes('alert.created'), false);
  assert.equal(second.res.text().includes('alert.created'), true);

  second.req.get('close');
  assert.equal(hub.size, 0);
});

test('5 分钟外的缓冲被清理；closeAll 结束全部连接', () => {
  let now = 1_760_000_000_000;
  const hub = new SseHub({ now: () => now });
  hub.publish('draft.created', { n: 'old' }, { tenantId: 'tn_a' });
  now += 4 * 60 * 1000;
  hub.publish('draft.created', { n: 'recent' }, { tenantId: 'tn_a' });
  now += 2 * 60 * 1000; // old 超出窗口，recent 还在
  const { res, close } = open(hub, { lastEventId: 'evt_missing' });
  assert.equal(res.text().includes('"n":"old"'), false);
  assert.equal(res.text().includes('"n":"recent"'), true);

  const other = open(hub);
  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(other.res.ended, true);
  close();
});

test('写失败时客户端自动下线', () => {
  const hub = new SseHub();
  const { res } = open(hub);
  res.write = () => {
    throw new Error('socked closed');
  };
  hub.publish('alert.created', {}, { tenantId: 'tn_a' });
  assert.equal(hub.size, 0);
});
