/**
 * 侧边栏接口客户端（#145）。
 *
 * 所有请求同源、带 Cookie；401 交给上层跳 OAuth，不在这里重试，
 * 避免授权失败时来回跳转。
 */
import type { AgentConfig, SidebarContextData } from './types.ts';

export const AUTH_START_PATH = '/zhiban/sidebar/auth/start';
const API_PREFIX = '/zhiban/sidebar';

export class SidebarApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SidebarApiError';
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      ...init,
    });
  } catch {
    throw new SidebarApiError(0, 'NETWORK_FAILED', '网络不可用');
  }

  if (!response.ok) {
    let code = 'HTTP_FAILED';
    let message = '请求失败';
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // 保留默认文案
    }
    throw new SidebarApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

/** 页面地址去掉 hash 后交给服务端签名；服务端只为自己同源的 URL 签名 */
export function fetchAgentConfig(pageUrl: string): Promise<AgentConfig> {
  return requestJson<AgentConfig>(`/jsapi-config?url=${encodeURIComponent(pageUrl)}`);
}

export function fetchContext(query: string): Promise<SidebarContextData> {
  return requestJson<SidebarContextData>(`/context?${query}`);
}

export type CloseReason = 'handled' | 'dismissed' | 'transferred';

/** 手动关闭：已处理 / 无需回复 / 转交。服务端会做同一条权限判断 */
export function postClose(id: string, reason: CloseReason): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/pending/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export type ClientEvent = 'sidebar.open' | 'pending.view' | 'pending.copy_excerpt' | 'draft.copy';

/** 埋点尽力而为：失败不打扰顾问 */
export async function postEvent(event: ClientEvent, itemId?: string): Promise<void> {
  try {
    await requestJson<{ ok: boolean }>('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, ...(itemId ? { itemId } : {}) }),
    });
  } catch {
    // 统计丢一条可以接受
  }
}
