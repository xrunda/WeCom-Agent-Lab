/**
 * #64 沙盒 HTTP 驱动。
 *
 * 只依赖控制台的公开接口（/zhiban/api），不直接读写 DSH 或数据库。
 * 账号密码来自命令行 / 环境变量，不落盘、不打印。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { SandboxDraft } from '../../src/p1/console-types.ts';

export interface SandboxClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

interface ConsoleErrorBody {
  error?: { code?: string; message?: string };
}

export class SandboxHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SandboxHttpError';
    this.status = status;
    this.code = code;
  }
}

export interface SandboxStateLike {
  session: { id: string; lastActiveAt: number };
  messages: Array<{ id: string; at: number; kind: string; text?: string; mediaId?: string }>;
  memories: Array<{ id: string; category: string; content: string; createdAt: number }>;
  drafts: SandboxDraft[];
  events: Array<{ at: number; type: string; data?: unknown }>;
  quota: { dailyLimit: number; usedToday: number; remaining: number };
}

export class SandboxClient {
  private readonly apiBase: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private cookie = '';

  constructor(options: SandboxClientOptions) {
    this.apiBase = normalizeApiBase(options.baseUrl);
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      let parsed: ConsoleErrorBody = {};
      try {
        parsed = (await res.json()) as ConsoleErrorBody;
      } catch {
        // 非 JSON 错误体，保留状态码
      }
      throw new SandboxHttpError(
        res.status,
        parsed.error?.code ?? `HTTP_${res.status}`,
        parsed.error?.message ?? `请求失败（${res.status}）`,
      );
    }
    return (await res.json()) as T;
  }

  async login(): Promise<void> {
    const res = await this.request('POST', '/auth/login', {
      username: this.username,
      password: this.password,
    });
    if (!res.ok) {
      throw new SandboxHttpError(res.status, 'LOGIN_FAILED', '登录失败，请检查账号或密码');
    }
    const cookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const raw = cookies.find((item) => item.startsWith('zhiban_session=')) ??
      res.headers.get('set-cookie') ??
      '';
    const match = raw.match(/zhiban_session=([^;]+)/);
    if (!match) throw new SandboxHttpError(500, 'NO_SESSION_COOKIE', '登录成功但未拿到会话 cookie');
    this.cookie = `zhiban_session=${match[1]}`;
  }

  async ensureSession(): Promise<SandboxStateLike['session']> {
    const view = await this.json<{ session: SandboxStateLike['session'] }>('POST', '/sandbox/session');
    return view.session;
  }

  async reset(): Promise<void> {
    await this.json('POST', '/sandbox/session/reset');
  }

  async state(): Promise<SandboxStateLike> {
    return this.json<SandboxStateLike>('GET', '/sandbox/state');
  }

  async quota(): Promise<SandboxStateLike['quota']> {
    return (await this.state()).quota;
  }

  async upload(imagePath: string): Promise<string> {
    const data = await readFile(imagePath);
    const form = new FormData();
    const type = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    form.append('file', new Blob([new Uint8Array(data)], { type }), basename(imagePath));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBase}/sandbox/uploads`, {
        method: 'POST',
        headers: this.cookie ? { cookie: this.cookie } : {},
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        let parsed: ConsoleErrorBody = {};
        try {
          parsed = (await res.json()) as ConsoleErrorBody;
        } catch {
          // 忽略非 JSON 错误体
        }
        throw new SandboxHttpError(
          res.status,
          parsed.error?.code ?? `HTTP_${res.status}`,
          parsed.error?.message ?? '图片上传失败',
        );
      }
      const media = (await res.json()) as { mediaId: string };
      return media.mediaId;
    } finally {
      clearTimeout(timer);
    }
  }

  async postText(text: string): Promise<number> {
    const result = await this.json<{ acceptedAt: number }>('POST', '/sandbox/messages', {
      kind: 'text',
      text,
    });
    return result.acceptedAt;
  }

  async postImage(mediaId: string): Promise<number> {
    const result = await this.json<{ acceptedAt: number }>('POST', '/sandbox/messages', {
      kind: 'image',
      mediaId,
    });
    return result.acceptedAt;
  }

  async waitForDraft(
    beforeIds: ReadonlySet<string>,
    acceptedAt: number,
    timeoutMs: number,
    pollMs = 1_000,
  ): Promise<{ draft: SandboxDraft; latencyMs: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.state();
      const fresh = state.drafts
        .filter((draft) => !beforeIds.has(draft.id) && draft.createdAt >= acceptedAt - 5_000)
        .sort((a, b) => b.createdAt - a.createdAt);
      const draft = fresh[0];
      if (draft) {
        return { draft, latencyMs: Math.max(0, draft.createdAt - acceptedAt) };
      }
      await sleep(pollMs);
    }
    throw new SandboxHttpError(504, 'DRAFT_TIMEOUT', `等待草稿超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  async draftIds(): Promise<Set<string>> {
    const state = await this.state();
    return new Set(state.drafts.map((draft) => draft.id));
  }
}

function normalizeApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/zhiban\/api$/.test(trimmed)) return trimmed;
  return `${trimmed}/zhiban/api`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
