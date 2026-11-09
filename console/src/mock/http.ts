/**
 * 控制台统一 HTTP 客户端。mock 层与各业务页面共用，
 * 真实模式下的接口前缀、错误结构与凭证处理都收敛在这里。
 */
export const API_BASE = import.meta.env.VITE_API_BASE || '/zhiban/api';

/** mock 模式：默认开启；部署时设 VITE_API_MODE=real 切到真实接口 */
export const isMockMode = import.meta.env.VITE_API_MODE !== 'real';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as T | ErrorPayload | null;

  if (!response.ok) {
    const error = payload && !Array.isArray(payload) ? (payload as ErrorPayload).error : undefined;
    throw new ApiError(
      error?.code || 'INTERNAL',
      error?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  return payload as T;
}
