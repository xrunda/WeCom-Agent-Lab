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

async function requestJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
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
