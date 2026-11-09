import accountsFixture from './fixtures/accounts.json';
import tenantFixture from './fixtures/tenant.json';
import type { Account, PatientTerm, Session, Tenant, TenantSettings } from '../types.ts';
import { PATIENT_TERMS } from '../types.ts';

const SESSION_KEY = 'zhiban.console.session';
const TENANT_KEY = 'zhiban.console.tenant';
const API_BASE = import.meta.env.VITE_API_BASE || '/zhiban/api';

/** mock 模式下的统一演示密码；真实模式不会用到 */
export const MOCK_PASSWORD = 'zhiban-demo';

/** mock 模式：默认开启；部署时设 VITE_API_MODE=real 切到真实接口 */
export const isMockMode = import.meta.env.VITE_API_MODE !== 'real';

const accounts = accountsFixture as unknown as Account[];
const tenantSeed = tenantFixture as unknown as Tenant;

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

const ROLE_PERMISSIONS: Record<Account['role'], string[]> = {
  admin: [
    'patient.read',
    'patient.write',
    'patient.delete',
    'group.read',
    'group.write',
    'advisor.read',
    'advisor.write',
    'advisor.pause',
    'draft.read',
    'draft.export',
    'alert.read',
    'alert.write',
    'knowledge.read',
    'knowledge.write',
    'rule.read',
    'rule.write',
    'script.read',
    'report.read',
    'skill.read',
    'solution.read',
    'setting.read',
    'setting.write',
    'account.read',
    'account.write',
    'audit.read',
    'audit.export',
    'security.read',
    'onboarding.read',
    'onboarding.write',
    'sandbox.use',
    'media.read',
    'sse.read',
  ],
  supervisor: [
    'patient.read',
    'patient.write',
    'group.read',
    'group.write',
    'advisor.read',
    'advisor.pause',
    'draft.read',
    'draft.export',
    'alert.read',
    'alert.write',
    'knowledge.read',
    'rule.read',
    'script.read',
    'report.read',
    'skill.read',
    'solution.read',
    'setting.read',
    'audit.read',
    'audit.export',
    'security.read',
    'onboarding.read',
    'onboarding.write',
    'sandbox.use',
    'media.read',
    'sse.read',
  ],
  viewer: [
    'patient.read',
    'group.read',
    'advisor.read',
    'draft.read',
    'alert.read',
    'knowledge.read',
    'rule.read',
    'script.read',
    'report.read',
    'skill.read',
    'solution.read',
    'setting.read',
    'audit.read',
    'security.read',
    'onboarding.read',
    'sandbox.use',
    'media.read',
    'sse.read',
  ],
};

function cloneTenant(tenant: Tenant): Tenant {
  return {
    ...tenant,
    settings: { ...tenant.settings, quietHours: { ...tenant.settings.quietHours } },
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式或存储被禁用时不影响当前会话
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

function loadTenant(): Tenant {
  return readJson<Tenant>(TENANT_KEY) ?? cloneTenant(tenantSeed);
}

function saveTenant(tenant: Tenant): void {
  writeJson(TENANT_KEY, tenant);
  const session = readJson<Session>(SESSION_KEY);
  if (session) writeJson(SESSION_KEY, { ...session, tenant });
}

function mockSession(account: Account): Session {
  return {
    account: {
      id: account.id,
      displayName: account.displayName,
      role: account.role,
    },
    tenant: loadTenant(),
    permissions: ROLE_PERMISSIONS[account.role],
    serverTime: Date.now(),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | T
    | null;

  if (!response.ok) {
    const error = payload && !Array.isArray(payload) ? (payload as { error?: { code?: string; message?: string } }).error : undefined;
    throw new ApiError(
      error?.code || 'INTERNAL',
      error?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  return payload as T;
}

export async function login(username: string, password: string): Promise<Session> {
  if (!isMockMode) {
    const session = await request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    writeJson(SESSION_KEY, session);
    return session;
  }

  const account = accounts.find((item) => item.username === username && !item.deletedAt);
  if (!account || password !== MOCK_PASSWORD) {
    throw new ApiError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
  }
  if (account.status !== 'active') {
    throw new ApiError('ACCOUNT_DISABLED', '账号已停用，请联系机构管理员', 403);
  }

  const session = mockSession(account);
  writeJson(SESSION_KEY, session);
  return session;
}

export async function getSession(): Promise<Session | null> {
  if (!isMockMode) {
    try {
      const session = await request<Session>('/auth/session');
      const tenant = await getTenant();
      return { ...session, tenant };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  const stored = readJson<Session>(SESSION_KEY);
  if (!stored) return null;
  return { ...stored, tenant: loadTenant(), serverTime: Date.now() };
}

export async function logout(): Promise<void> {
  if (!isMockMode) {
    await request<void>('/auth/logout', { method: 'POST' }).catch(() => undefined);
  }
  removeKey(SESSION_KEY);
}

export async function getTenant(): Promise<Tenant> {
  if (!isMockMode) return request<Tenant>('/tenant');
  return loadTenant();
}

export interface TenantPatch {
  name?: string;
  agentName?: string;
  agentAvatar?: string | null;
  patientTerm?: PatientTerm;
  tone?: string;
  timezone?: string;
  settings?: Partial<TenantSettings>;
}

export async function updateTenant(patch: TenantPatch): Promise<Tenant> {
  if (!isMockMode) {
    return request<Tenant>('/tenant', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  if (patch.patientTerm && !PATIENT_TERMS.includes(patch.patientTerm)) {
    throw new ApiError('VALIDATION_FAILED', '称谓只能是「患者 / 客户 / 会员」', 422);
  }

  const current = loadTenant();
  const next: Tenant = {
    ...current,
    ...patch,
    settings: {
      ...current.settings,
      ...patch.settings,
      quietHours: {
        ...current.settings.quietHours,
        ...patch.settings?.quietHours,
      },
    },
    updatedAt: Date.now(),
  };
  saveTenant(next);
  return next;
}

/** 仅供测试：把 mock 状态恢复到 fixture */
export function resetMockState(): void {
  removeKey(SESSION_KEY);
  removeKey(TENANT_KEY);
}
