import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionCan } from '../src/auth/AuthContext.tsx';
import type { Session } from '../src/types.ts';

const account = {
  id: 'acc_test',
  tenantId: 'tn_test',
  username: 'admin',
  displayName: '林主管',
  role: 'admin',
  status: 'active',
  lastLoginAt: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

const tenant = {
  id: 'tn_test',
  name: '测试机构',
  agentName: '小安',
  patientTerm: '患者',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('真实模式登录会话', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_MODE', 'real');
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('登录接口只返回 account/tenant 时，补拉 /auth/session 的 permissions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ account, tenant }))
      .mockResolvedValueOnce(
        jsonResponse({ account, tenant, permissions: ['tenant.write'], serverTime: 1000 }),
      )
      .mockResolvedValueOnce(jsonResponse(tenant));
    vi.stubGlobal('fetch', fetchMock);

    const { login } = await import('../src/mock/api.ts');
    const session = await login('admin', 'secret');

    expect(session.permissions).toEqual(['tenant.write']);
    expect(sessionCan(session, 'tenant.write')).toBe(true);
  });

  it('会话查询失败时登录仍成功，但按无权限处理', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ account, tenant }))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const { login } = await import('../src/mock/api.ts');
    const session = await login('admin', 'secret');

    expect(session.permissions).toEqual([]);
    expect(sessionCan(session, 'tenant.write')).toBe(false);
  });

  it('permissions 缺失的会话不会抛错', () => {
    const broken = { permissions: undefined } as unknown as Session;
    expect(sessionCan(broken, 'tenant.write')).toBe(false);
    expect(sessionCan(null, 'tenant.write')).toBe(false);
  });
});
