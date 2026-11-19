import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { WebSocket } from 'ws';

import { sniffImageMediaType } from '../../p1/vision.ts';
import type { BotPort } from '../ports.ts';
import type { CardPayload } from '../types.ts';

/** #55：企微机器人 image 消息上限 2 MB，只支持 JPG / PNG */
const SEND_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 上传临时素材的 media_id 有效期 3 天；缓存 2 天后重新上传 */
const MEDIA_CACHE_TTL_MS = 2 * 24 * 60 * 60_000;
/** 分片大小：512KB（Base64 编码前），官方 SDK 口径 */
const UPLOAD_CHUNK_BYTES = 512 * 1024;

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
  /**
   * #226 断线自动重连的退避序列（毫秒）；用尽后固定取最后一个值持续重试。
   * 传空数组等价于不重连。
   */
  reconnectDelaysMs?: number[];
  /**
   * #226 连续 ping 失败多少次判定长连接已半开（对端消失但没有 close 帧）。
   * 默认 2。
   */
  pingFailureLimit?: number;
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
  /** #226 自动重连成功；attempts 为本次断线累计尝试次数，downMs 为断开时长 */
  onReconnected?: (info: { attempts: number; downMs: number }) => void;
}

/** 订阅被服务端拒绝：凭据错误等，重试也不会好，用来跟「网络失败」区分 */
export class SubscribeFailedError extends Error {
  readonly fatal = true;
}

interface Frame {
  cmd?: string;
  headers?: { req_id?: string };
  errcode?: number;
  errmsg?: string;
  body?: Record<string, unknown>;
}

const DEFAULT_URL = 'wss://openws.work.weixin.qq.com';

/** #226 重连退避：1s → 3s → 10s → 30s → 60s，之后每 60s 一次，不放弃 */
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];
/** 心跳判定半开时对外的关闭码（沿用 WS 规范的异常断开码） */
const BOT_HEARTBEAT_LOST_CODE = 1006;

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
  /** 显式关闭（插件卸载 / 被顶替）；置位后不再重连 */
  private stopped = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  /** #226 心跳连续失败次数；成功一次清零 */
  private pingFailures = 0;
  /** #226 重连定时器与本次断线的进度 */
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private downSince?: number;
  private seq = 0;
  private msgSeq = 0;
  /** 内容 md5 → media_id；临时素材有效期 3 天，这里保守缓存 2 天 */
  private readonly mediaCache = new Map<string, { mediaId: string; at: number }>();
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
      reconnectDelaysMs: DEFAULT_RECONNECT_DELAYS_MS,
      pingFailureLimit: 2,
      ...config,
    };
    this.handlers = handlers;
  }

  /** 首次连接：失败直接抛错，让启动阶段看得见 */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.openConnection();
  }

  /** 建连 + 订阅；首次连接与自动重连共用，调用方负责处理错误 */
  private async openConnection(): Promise<void> {
    if (this.stopped || this.ws) return;

    const factory: WebSocketFactory =
      this.config.wsFactory ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    const ws = factory(this.config.url);
    this.ws = ws;

    ws.on('message', (data) => this.handleFrame(String(data)));
    // 带上 socket 自身：旧连接迟到的 close 事件不能把新连接拆掉
    ws.on('close', (code) => this.handleClose(Number(code), ws));
    ws.on('error', (error) => {
      this.log(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS_CONNECT_TIMEOUT')), this.config.requestTimeoutMs);
        // 重连期间可能一直在等建连，这个计时器不能单独把进程钉住
        timer.unref?.();
        ws.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        // 建连过程中被关闭：立刻失败，不用干等 15 秒超时
        ws.once('close', (code) => {
          clearTimeout(timer);
          reject(new Error(`WS_CLOSED_DURING_CONNECT code=${String(code)}`));
        });
      });
    } catch (error) {
      this.teardown();
      throw error;
    }

    // 建连期间被显式关闭或被新连接替换：不再继续订阅
    if (this.stopped || this.ws !== ws) return;

    this.startPing();
    let res: Frame;
    try {
      res = await this.request('aibot_subscribe', {
        bot_id: this.config.botId,
        secret: this.config.secret,
      });
    } catch (error) {
      // 订阅请求本身失败（超时 / 连接已断）：清干净再抛，否则 ws 留着会挡住下一次重连
      this.teardown();
      try {
        ws.close();
      } catch {
        // 已断开的连接 close 可能抛错，忽略
      }
      throw error;
    }
    if (res.errcode !== 0) {
      this.teardown();
      try {
        ws.close();
      } catch {
        // 已断开的连接 close 可能抛错，忽略
      }
      throw new SubscribeFailedError(
        `SUBSCRIBE_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim(),
      );
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

  /**
   * #55 / #208：把患者原图转推给顾问。
   * 智能机器人发图必须先「上传临时素材」拿 media_id（三步分片），
   * 再发 `msgtype=image` + `image.media_id`；不再用群机器人的 base64+md5。
   * 路径不进日志，media_id 按内容 md5 缓存（有效期 3 天，这里保守缓存 2 天）。
   */
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

    const mediaId = await this.uploadImage(data, path);
    const res = await this.request('aibot_send_msg', {
      chatid: chatId,
      chat_type: 1,
      msgtype: 'image',
      image: { media_id: mediaId },
    });
    if (res.errcode !== 0) {
      throw new Error(`SEND_IMAGE_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim());
    }
    return { messageId: `local_image_${++this.msgSeq}` };
  }

  /** 三步分片上传：init → chunk × N → finish，返回 media_id */
  private async uploadImage(data: Buffer, path: string): Promise<string> {
    const md5 = createHash('md5').update(data).digest('hex');
    const cached = this.mediaCache.get(md5);
    if (cached && Date.now() - cached.at < MEDIA_CACHE_TTL_MS) return cached.mediaId;

    const chunkSize = UPLOAD_CHUNK_BYTES;
    const totalChunks = Math.ceil(data.length / chunkSize);
    if (totalChunks > 100) throw new Error('SEND_IMAGE_TOO_LARGE');

    const init = await this.request('aibot_upload_media_init', {
      type: 'image',
      filename: path.split('/').pop() || 'image.jpg',
      total_size: data.length,
      total_chunks: totalChunks,
      md5,
    });
    if (init.errcode !== 0) {
      throw new Error(`UPLOAD_INIT_FAILED ${init.errcode} ${init.errmsg ?? ''}`.trim());
    }
    const uploadId = init.body?.upload_id;
    if (typeof uploadId !== 'string' || uploadId === '') {
      throw new Error('UPLOAD_INIT_FAILED no upload_id');
    }

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const chunk = data.subarray(start, Math.min(start + chunkSize, data.length));
      const res = await this.request('aibot_upload_media_chunk', {
        upload_id: uploadId,
        chunk_index: index,
        base64_data: chunk.toString('base64'),
      });
      if (res.errcode !== 0) {
        throw new Error(`UPLOAD_CHUNK_FAILED ${res.errcode} ${res.errmsg ?? ''}`.trim());
      }
    }

    const finish = await this.request('aibot_upload_media_finish', { upload_id: uploadId });
    if (finish.errcode !== 0) {
      throw new Error(`UPLOAD_FINISH_FAILED ${finish.errcode} ${finish.errmsg ?? ''}`.trim());
    }
    const mediaId = finish.body?.media_id;
    if (typeof mediaId !== 'string' || mediaId === '') {
      throw new Error('UPLOAD_FINISH_FAILED no media_id');
    }

    if (this.mediaCache.size > 200) this.mediaCache.clear();
    this.mediaCache.set(md5, { mediaId, at: Date.now() });
    return mediaId;
  }

  /** 显式关闭：插件卸载或被新连接顶替，之后不再重连 */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.teardown();
    try {
      ws?.close();
    } catch {
      // 已断开的连接 close 可能抛错，忽略
    }
  }

  /** 断连收尾：置空连接、停心跳、拒掉所有在途请求；不决定要不要重连 */
  private teardown(): void {
    this.authed = false;
    this.ws = undefined;
    this.stopPing();
    this.pingFailures = 0;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WS_CLOSED'));
      this.pending.delete(id);
    }
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
        // 同一个机器人只允许一条长连接（F14）；被顶替时重连会和对方互踢，必须停
        this.log('长连接被新连接顶替，停止重连');
        this.close();
        return;
      default:
        this.log(`收到未识别帧：cmd=${String(frame.cmd ?? '-')} 长度=${raw.length}`);
    }
  }

  private handleClose(code: number, socket: WebSocketLike): void {
    // 旧连接迟到的 close：当前连接已经是别的 socket，什么都别动
    if (this.ws !== socket) return;
    const wasAuthed = this.authed;
    this.log(`WebSocket 关闭 code=${code}`);
    this.teardown();
    if (this.stopped) return;
    if (!wasAuthed) {
      // 还没订阅成功就断了：由 connect()（首次）或 attemptReconnect（重连）的
      // 调用方负责重试，这里不重复排程
      this.log('建连阶段连接关闭，交由调用方重试');
      return;
    }
    this.handlers.onClose?.(code);
    // #226：异常断开必须自己接回来，否则 1:1 渠道会一直哑到人工重启
    this.scheduleReconnect();
  }

  /** 心跳连续失败：连接已半开（对端没了但没有 close 帧），主动丢弃并重连 */
  private dropHalfOpen(): void {
    const ws = this.ws;
    this.log('心跳连续无响应，判定长连接已半开，主动断开重连');
    this.teardown();
    try {
      ws?.close();
    } catch {
      // 已死的连接 close 可能抛错，忽略
    }
    if (this.stopped) return;
    this.handlers.onClose?.(BOT_HEARTBEAT_LOST_CODE);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delays = this.config.reconnectDelaysMs ?? [];
    if (delays.length === 0) return;
    const index = Math.min(this.reconnectAttempt, delays.length - 1);
    const delay = delays[index] ?? DEFAULT_RECONNECT_DELAYS_MS.at(-1)!;
    this.reconnectAttempt += 1;
    if (this.downSince === undefined) this.downSince = Date.now();
    this.log(`第 ${this.reconnectAttempt} 次重连将在 ${delay}ms 后尝试`);
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private async attemptReconnect(): Promise<void> {
    if (this.stopped || this.ws) return;
    const attempts = this.reconnectAttempt;
    try {
      await this.openConnection();
      if (this.stopped) return;
      const downMs = this.downSince === undefined ? 0 : Date.now() - this.downSince;
      this.reconnectAttempt = 0;
      this.downSince = undefined;
      this.log(`长连接已恢复（尝试 ${attempts} 次，断开约 ${Math.round(downMs / 1_000)}s）`);
      this.handlers.onReconnected?.({ attempts, downMs });
    } catch (error) {
      if (error instanceof SubscribeFailedError) {
        // 凭据错误等：重试也不会好，停下来等人工处理，避免每次连接都被踢
        this.stopped = true;
        this.log(`重连被服务端拒绝，停止重连：${error.message}`);
        return;
      }
      this.log(
        `第 ${attempts} 次重连失败：${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleReconnect();
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
    this.pingFailures = 0;
    this.pingTimer = setInterval(() => {
      if (!this.authed || this.ws === undefined) return;
      this.request('ping')
        .then(() => {
          this.pingFailures = 0;
        })
        .catch((error: unknown) => {
          if (this.stopped || this.ws === undefined) return;
          this.pingFailures += 1;
          this.log(
            `ping 失败（连续 ${this.pingFailures} 次）：${error instanceof Error ? error.message : String(error)}`,
          );
          // #226：半开连接不会触发 close，只能靠心跳次数兜底
          if (this.pingFailures >= (this.config.pingFailureLimit ?? 2)) this.dropHalfOpen();
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
