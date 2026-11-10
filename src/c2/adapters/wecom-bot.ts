import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { WebSocket } from 'ws';

import { sniffImageMediaType } from '../../p1/vision.ts';
import type { BotPort } from '../ports.ts';
import type { CardPayload } from '../types.ts';

/** #55：企微机器人 image 消息上限 2 MB，只支持 JPG / PNG */
const SEND_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

type Logger = (line: string) => void;

export type WsEvent = 'open' | 'message' | 'close' | 'error' | 'unexpected-response';

/** 只依赖用到的方法，便于测试注入假 WebSocket */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: WsEvent, listener: (...args: unknown[]) => void): void;
  once(event: WsEvent, listener: (...args: unknown[]) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WeComBotConfig {
  botId: string;
  secret: string;
  /** 默认 wss://openws.work.weixin.qq.com */
  url?: string;
  pingIntervalMs?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  /** 测试注入；默认使用 ws 包 */
  wsFactory?: WebSocketFactory;
}

export interface InboundMessage {
  userid: string;
  chattype: 'single' | 'group';
  /** 单聊就是 userid；群聊是回调里的 chatid */
  chatid: string;
  msgtype: string;
  text?: string;
  raw: unknown;
}

export interface InboundEvent {
  eventtype: string;
  eventKey?: string;
  taskId?: string;
  userid?: string;
  raw: unknown;
}

export interface WeComBotHandlers {
  onMessage?: (message: InboundMessage) => void;
  onEvent?: (event: InboundEvent) => void;
  onClose?: (code: number) => void;
}

interface Frame {
  cmd?: string;
  headers?: { req_id?: string };
  errcode?: number;
  errmsg?: string;
  body?: Record<string, unknown>;
}

const DEFAULT_URL = 'wss://openws.work.weixin.qq.com';

/**
 * API 模式智能机器人长连接适配器。
 *
 * 已由 C2-0 实测确认：
 * - 单聊推送 chatid = 员工 userid，chat_type = 1
 * - 主动推送用 template_card / markdown（不支持 text）
 * - 按钮回调字段为 event.template_card_event.event_key
 */
export class WeComBotAdapter implements BotPort {
  private readonly config: Required<Pick<WeComBotConfig, 'url' | 'pingIntervalMs' | 'requestTimeoutMs'>> &
    WeComBotConfig;
  private readonly handlers: WeComBotHandlers;
  private ws?: WebSocketLike;
  private authed = false;
  private closed = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private seq = 0;
  private msgSeq = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (frame: Frame) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(config: WeComBotConfig, handlers: WeComBotHandlers = {}) {
    this.config = {
      url: DEFAULT_URL,
      pingIntervalMs: 30_000,
      requestTimeoutMs: 15_000,
      ...config,
    };
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    if (this.ws) return;

    const factory: WebSocketFactory =
      this.config.wsFactory ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    const ws = factory(this.config.url);
    this.ws = ws;

    ws.on('message', (data) => this.handleFrame(String(data)));
    ws.on('close', (code) => this.handleClose(Number(code)));
    ws.on('error', (error) => {
      this.log(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS_CONNECT_TIMEOUT')), this.config.requestTimeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    this.startPing();
    const res = await this.request('aibot_subscribe', {
      bot_id: this.config.botId,
      secret: this.config.secret,
    });
    if (res.errcode !== 0) {
      this.close();
      throw new Error(`SUBSCRIBE_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim());
    }
    this.authed = true;
    this.log('已订阅智能机器人长连接');
  }

  async sendCard(chatId: string, card: CardPayload): Promise<{ messageId: string }> {
    const res = await this.request('aibot_send_msg', {
      chatid: chatId,
      chat_type: 1,
      msgtype: 'template_card',
      template_card: card.template_card,
    });
    if (res.errcode === 42014) {
      // task_id 已存在：大概率是上次推送成功但响应丢了，按幂等视为已送达
      this.log('卡片 task_id 已存在，视为已送达');
      return { messageId: `local_card_${++this.msgSeq}` };
    }
    if (res.errcode !== 0) throw new Error(`SEND_CARD_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim());
    return { messageId: `local_card_${++this.msgSeq}` };
  }

  async sendText(chatId: string, text: string): Promise<{ messageId: string }> {
    // 平台主动推送不支持 msgtype=text，用 markdown 承载纯文本
    const res = await this.request('aibot_send_msg', {
      chatid: chatId,
      chat_type: 1,
      msgtype: 'markdown',
      markdown: { content: text },
    });
    if (res.errcode !== 0) throw new Error(`SEND_TEXT_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim());
    return { messageId: `local_text_${++this.msgSeq}` };
  }

  /** #55：把患者原图转推给顾问；md5 按原始字节计算，路径不进日志 */
  async sendImage(chatId: string, path: string): Promise<{ messageId: string }> {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new Error('SEND_IMAGE_READ_FAILED');
    }
    if (data.length > SEND_IMAGE_MAX_BYTES) throw new Error('SEND_IMAGE_TOO_LARGE');
    const mediaType = sniffImageMediaType(data);
    if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') {
      throw new Error('SEND_IMAGE_UNSUPPORTED');
    }
    const md5 = createHash('md5').update(data).digest('hex');
    const res = await this.request('aibot_send_msg', {
      chatid: chatId,
      chat_type: 1,
      msgtype: 'image',
      image: { base64: data.toString('base64'), md5 },
    });
    if (res.errcode !== 0) {
      throw new Error(`SEND_IMAGE_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim());
    }
    return { messageId: `local_image_${++this.msgSeq}` };
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WS_CLOSED'));
      this.pending.delete(id);
    }
    this.ws?.close();
    this.ws = undefined;
  }

  private handleFrame(raw: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      this.log(`收到非 JSON 帧：长度=${raw.length}`);
      return;
    }

    if (frame.cmd === undefined && frame.errcode !== undefined) {
      const reqId = frame.headers?.req_id;
      if (!reqId) return;
      const entry = this.pending.get(reqId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(reqId);
      entry.resolve(frame);
      return;
    }

    switch (frame.cmd) {
      case 'aibot_msg_callback': {
        const body = frame.body ?? {};
        const from = (body.from ?? {}) as Record<string, unknown>;
        const userid = String(from.userid ?? from.user_id ?? '');
        const chattype = body.chattype === 'group' ? 'group' : 'single';
        const chatid = chattype === 'group' ? String(body.chatid ?? '') : userid;
        const text =
          (body.text as { content?: string } | undefined)?.content ??
          (body.markdown as { content?: string } | undefined)?.content;
        if (!userid) {
          this.log('aibot_msg_callback 缺少 from.userid');
          return;
        }
        this.handlers.onMessage?.({
          userid,
          chattype,
          chatid,
          msgtype: String(body.msgtype ?? ''),
          text,
          raw: frame,
        });
        return;
      }
      case 'aibot_event_callback': {
        const body = frame.body ?? {};
        const event = (body.event ?? {}) as Record<string, unknown>;
        const cardEvent = (event.template_card_event ?? {}) as Record<string, unknown>;
        this.handlers.onEvent?.({
          eventtype: String(event.eventtype ?? ''),
          eventKey: cardEvent.event_key === undefined ? undefined : String(cardEvent.event_key),
          taskId: cardEvent.task_id === undefined ? undefined : String(cardEvent.task_id),
          userid:
            (body.from as { userid?: string } | undefined)?.userid ??
            (body.userid === undefined ? undefined : String(body.userid)),
          raw: frame,
        });
        return;
      }
      case 'disconnected_event':
        this.log('长连接被新连接顶替，停止重连');
        this.close();
        return;
      default:
        this.log(`收到未识别帧：cmd=${String(frame.cmd ?? '-')} 长度=${raw.length}`);
    }
  }

  private handleClose(code: number): void {
    this.stopPing();
    this.ws = undefined;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WS_CLOSED'));
      this.pending.delete(id);
    }
    if (!this.closed) {
      this.log(`WebSocket 关闭 code=${code}`);
      this.handlers.onClose?.(code);
    }
  }

  private request(cmd: string, body?: Record<string, unknown>): Promise<Frame> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('WS_NOT_CONNECTED'));
    const reqId = `c2-${Date.now()}-${++this.seq}`;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`WS_REQUEST_TIMEOUT ${cmd}`));
      }, this.config.requestTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          cmd,
          headers: { req_id: reqId },
          ...(body === undefined ? {} : { body }),
        }),
      );
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.authed) return;
      this.request('ping').catch((error: unknown) => {
        this.log(`ping 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.config.pingIntervalMs);
    // 不阻塞进程退出（测试与 CLI 都只靠长连接本身保活）
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private log(line: string): void {
    this.config.logger?.(line);
  }
}
