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

/**
 * 5xx 的默认文案。浏览器和代理层的报错只有状态码（例如本地 dev 代理连不上
 * 后端时，vite 直接回 500 且没有响应体），原样展示「请求失败（HTTP 500）」
 * 对使用者没有信息量。这里给出下一步动作，同时保留状态码方便排查。
 */
const SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试；持续出现请联系管理员';

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers,
    });
  } catch {
    // fetch 抛错说明请求根本没出门：断网、跨域被拦、或服务没启动
    throw new ApiError('NETWORK', '连不上服务，请检查网络或确认后端已启动', 0);
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as T | ErrorPayload | null;

  if (!response.ok) {
    const error = payload && !Array.isArray(payload) ? (payload as ErrorPayload).error : undefined;
    const fallback =
      response.status >= 500
        ? `${SERVER_ERROR_MESSAGE}（HTTP ${response.status}）`
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(error?.code || 'INTERNAL', error?.message || fallback, response.status);
  }

  return payload as T;
}
