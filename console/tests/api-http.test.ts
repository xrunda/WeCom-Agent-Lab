import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from '../src/mock/http.ts';

function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest 错误文案', () => {
  it('5xx 且没有响应体时给出可行动的默认文案，并保留状态码', async () => {
    // 本地 dev 代理连不上后端时，vite 回的就是空体 500
    stubFetch(async () => new Response('', { status: 500 }));

    const error = (await apiRequest('/auth/login').catch((err: ApiError) => err)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('服务暂时不可用');
    expect(error.message).toContain('HTTP 500');
  });

  it('5xx 带后端错误时以后端文案为准', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'DB_DOWN', message: '数据库连接失败' } }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
    );

    const error = (await apiRequest('/patients').catch((err: ApiError) => err)) as ApiError;
    expect(error.code).toBe('DB_DOWN');
    expect(error.message).toBe('数据库连接失败');
  });

  it('4xx 仍用「请求失败（HTTP n）」', async () => {
    stubFetch(async () => new Response('', { status: 401 }));

    const error = (await apiRequest('/auth/session').catch((err: ApiError) => err)) as ApiError;
    expect(error.status).toBe(401);
    expect(error.message).toBe('请求失败（HTTP 401）');
  });

  it('请求没出门（fetch 抛错）时提示网络或后端未启动', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    const error = (await apiRequest('/auth/login').catch((err: ApiError) => err)) as ApiError;
    expect(error.code).toBe('NETWORK');
    expect(error.message).toContain('连不上服务');
  });
});
