import accountsFixture from './fixtures/accounts.json';
import tenantFixture from './fixtures/tenant.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';
import type { Account, PatientTerm, Session, Tenant, TenantSettings } from '../types.ts';
import { PATIENT_TERMS } from '../types.ts';

export { ApiError, isMockMode } from './http.ts';

const SESSION_KEY = 'zhiban.console.session';
const TENANT_KEY = 'zhiban.console.tenant';

/** mock 模式下的统一演示密码；真实模式不会用到 */
export const MOCK_PASSWORD = 'zhiban-demo';

const accounts = accountsFixture as unknown as Account[];
const tenantSeed = tenantFixture as unknown as Tenant;

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
  return apiRequest<T>(path, init);
}

export async function login(username: string, password: string): Promise<Session> {
  if (!isMockMode) {
    const loginResult = await request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    // POST /auth/login 按契约只返回 account/tenant（docs/P1-api.md §2），
    // permissions 与 serverTime 在 GET /auth/session。登录后补一次会话查询，
    // 否则 can() 会读到 undefined，任何调用 can() 的页面都会崩溃。
    const full = await getSession().catch(() => null);
    const session: Session = full ?? {
      ...loginResult,
      permissions: [],
      serverTime: Date.now(),
    };
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
