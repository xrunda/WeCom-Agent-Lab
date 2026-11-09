/**
 * #41 SSE 通道：`/zhiban/api/stream`。
 *
 * - 15 秒注释心跳 `: ping`
 * - 内存环形缓冲保留最近 5 分钟事件，断线重连带 Last-Event-ID 时补发
 * - types 支持前缀通配：draft.* / alert.* / sandbox.*
 * - 不是事实来源：前端重连后仍需 REST 拉一次状态
 */
import { randomUUID } from 'node:crypto';

import type { HttpRequestLike, HttpResponseLike } from './http.ts';

export interface SseEnvelope {
  id: string;
  type: string;
  at: number;
  tenantId: string;
  sandbox: boolean;
  data: unknown;
}

interface SseClient {
  res: HttpResponseLike;
  types: string[];
  tenantId: string;
  close(): void;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const MAX_BUFFER = 500;

function matches(types: string[], type: string): boolean {
  if (types.length === 0) return true;
  return types.some((item) => {
    if (item === type) return true;
    if (item.endsWith('.*')) return type.startsWith(item.slice(0, -1));
    return false;
  });
}

export function parseEventTypes(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly buffer: SseEnvelope[] = [];
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  publish(
    type: string,
    data: unknown,
    options: { tenantId: string; sandbox?: boolean },
  ): SseEnvelope {
    const envelope: SseEnvelope = {
      id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type,
      at: this.now(),
      tenantId: options.tenantId,
      sandbox: options.sandbox === true,
      data,
    };
    this.buffer.push(envelope);
    this.prune();
    for (const client of this.clients) {
      if (client.tenantId !== envelope.tenantId) continue;
      if (!matches(client.types, envelope.type)) continue;
      this.write(client, envelope);
    }
    return envelope;
  }

  /** 返回关闭函数；handler 的所有权交给调用方 */
  open(
    req: HttpRequestLike,
    res: HttpResponseLike,
    options: { tenantId: string; types: string[]; lastEventId?: string },
  ): () => void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        client.close();
      }
    }, HEARTBEAT_MS);
    (heartbeat as { unref?: () => void }).unref?.();

    const client: SseClient = {
      res,
      types: options.types,
      tenantId: options.tenantId,
      close: () => {
        clearInterval(heartbeat);
        this.clients.delete(client);
      },
    };
    this.clients.add(client);

    if (options.lastEventId) this.replay(client, options.lastEventId);

    const onClose = () => client.close();
    req.on?.('close', onClose as never);
    res.on?.('close', onClose as never);

    return () => {
      client.close();
      try {
        res.end();
      } catch {
        // 已断开
      }
    };
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      client.close();
      try {
        client.res.end();
      } catch {
        // 已断开
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  private replay(client: SseClient, lastEventId: string): void {
    this.prune();
    const index = this.buffer.findIndex((item) => item.id === lastEventId);
    const start = index >= 0 ? index + 1 : 0;
    for (const envelope of this.buffer.slice(start)) {
      if (envelope.tenantId !== client.tenantId) continue;
      if (!matches(client.types, envelope.type)) continue;
      this.write(client, envelope);
    }
  }

  private write(client: SseClient, envelope: SseEnvelope): void {
    try {
      client.res.write(
        `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
      );
    } catch {
      client.close();
    }
  }

  private prune(): void {
    const cutoff = this.now() - REPLAY_WINDOW_MS;
    while (this.buffer.length > 0 && this.buffer[0]!.at < cutoff) this.buffer.shift();
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
  }
}
