import accountsFixture from './fixtures/accounts.json';
import auditFixture from './fixtures/audit-events.json';
import tenantFixture from './fixtures/tenant.json';
import { getSession } from './api.ts';
import { API_BASE, ApiError, apiRequest, isMockMode } from './http.ts';
import { mockId, readStore, toQuery, writeStore } from './storage.ts';
import type {
  Account,
  AuditEvent,
  AuditFilters,
  ModelStatus,
  PermissionMatrix,
  Role,
  Tenant,
  WecomStatus,
} from '../types.ts';

const ACCOUNTS_KEY = 'zhiban.console.accounts';
const AUDIT_KEY = 'zhiban.console.audit';
const WECOM_KEY = 'zhiban.console.wecom-connection';
const TENANT_ID = (tenantFixture as unknown as Tenant).id;

const ROLE_LABELS: Record<Role, string> = {
  admin: '机构管理员',
  supervisor: '主管',
  viewer: '只读',
};

const MATRIX: PermissionMatrix = {
  roles: [
    { role: 'admin', label: '机构管理员', permissions: ['*'] },
    {
      role: 'supervisor',
      label: '主管',
      permissions: [
        'patient.read',
        'patient.write',
        'draft.read',
        'alert.write',
        'advisor.operate',
        'audit.read',
        'export',
      ],
    },
    {
      role: 'viewer',
      label: '只读',
      permissions: ['patient.read', 'draft.read', 'alert.read', 'audit.read'],
    },
  ],
};

function loadAccounts(): Account[] {
  return readStore<Account[]>(ACCOUNTS_KEY, accountsFixture as unknown as Account[]);
}

function saveAccounts(items: Account[]): void {
  writeStore(ACCOUNTS_KEY, items);
}

async function actor(): Promise<{ id: string | null; name: string }> {
  const session = await getSession();
  return {
    id: session?.account.id ?? null,
    name: session?.account.displayName ?? 'system',
  };
}

export async function recordAudit(input: {
  action: string;
  targetType: string;
  targetId: string | null;
  result?: AuditEvent['result'];
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  const who = await actor();
  const event: AuditEvent = {
    id: mockId('aud'),
    tenantId: TENANT_ID,
    actorType: who.id ? 'account' : 'system',
    actorId: who.id,
    actorName: who.name,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    result: input.result ?? 'success',
    detail: input.detail ?? null,
    errorCode: null,
    ip: '203.0.113.*',
    at: Date.now(),
    sandbox: false,
  };
  writeStore(AUDIT_KEY, [event, ...loadAudit()]);
}

function loadAudit(): AuditEvent[] {
  return readStore<AuditEvent[]>(AUDIT_KEY, auditFixture as unknown as AuditEvent[]);
}

/* ---------- 企微接入状态 ---------- */

function botConnected(): boolean {
  const stored = (() => {
    try {
      return localStorage.getItem(WECOM_KEY);
    } catch {
      return null;
    }
  })();
  return stored !== 'disconnected';
}

/** GET /settings/wecom/status */
export async function getWecomStatus(): Promise<WecomStatus> {
  if (!isMockMode) return apiRequest('/settings/wecom/status');
  const now = Date.now();
  const connected = botConnected();
  return {
    archive: {
      status: 'green',
      message: '正常',
      lastPolledAt: now - 4_000,
      lastSeq: 128_431,
      lagSeconds: 4,
    },
    bot: connected
      ? {
          status: 'green',
          message: '长连接正常',
          connectedSince: now - 86_400_000,
          lastDisconnectAt: null,
        }
      : {
          status: 'red',
          message: '长连接已断开，消息可能延迟',
          connectedSince: null,
          lastDisconnectAt: now - 20_000,
        },
    host: {
      status: 'green',
      message: '运行中',
      uptimeSeconds: 86_400,
      version: '0.2.1-rc.5',
    },
    seat: {
      purchased: 1,
      expiresAt: Date.parse('2027-06-30T23:59:59+08:00'),
      message: '1 个席位，2027-06-30 到期',
    },
    checkedAt: now,
  };
}

/** mock 演示：模拟机器人长连接断开/恢复，真实模式不提供 */
export function setMockBotConnected(connected: boolean): void {
  try {
    localStorage.setItem(WECOM_KEY, connected ? 'connected' : 'disconnected');
  } catch {
    // 忽略存储不可用
  }
}

/** GET /settings/model */
export async function getModelStatus(): Promise<ModelStatus> {
  if (!isMockMode) return apiRequest('/settings/model');
  return {
    model: 'deepseek-v4.1-flash',
    callsToday: 142,
    avgLatencyMs: 3_120,
    fallbackCount: 3,
    estimatedCostYuanToday: 0.86,
    updatedAt: Date.now(),
  };
}

/* ---------- 账号 ---------- */

export interface AccountInput {
  username: string;
  displayName: string;
  role: Role;
  password: string;
}

export interface AccountPatch {
  displayName?: string;
  role?: Role;
  status?: Account['status'];
}

/** GET /accounts */
export async function listAccounts(
  params: { role?: Role; status?: Account['status'] } = {},
): Promise<{ items: Account[]; total: number }> {
  if (!isMockMode) return apiRequest(`/accounts${toQuery(params)}`);

  let items = loadAccounts().filter((account) => account.deletedAt === null);
  if (params.role) items = items.filter((account) => account.role === params.role);
  if (params.status) items = items.filter((account) => account.status === params.status);
  const order: Record<Role, number> = { admin: 0, supervisor: 1, viewer: 2 };
  items = [...items].sort((a, b) => order[a.role] - order[b.role] || a.username.localeCompare(b.username));
  return { items, total: items.length };
}

/** POST /accounts */
export async function createAccount(input: AccountInput): Promise<Account> {
  if (!isMockMode) {
    return apiRequest('/accounts', { method: 'POST', body: JSON.stringify(input) });
  }

  const username = input.username.trim();
  const displayName = input.displayName.trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new ApiError('VALIDATION_FAILED', '用户名需为 3–32 位字母、数字、点、下划线或短横线', 422);
  }
  if (!displayName) throw new ApiError('VALIDATION_FAILED', '请填写显示名', 422);
  if (!input.role || !(input.role in ROLE_LABELS)) {
    throw new ApiError('VALIDATION_FAILED', '角色不合法', 422);
  }
  if (!input.password || input.password.length < 8) {
    throw new ApiError('VALIDATION_FAILED', '初始密码至少 8 位', 422);
  }

  const items = loadAccounts();
  const exists = items.some(
    (account) => account.deletedAt === null && account.username.toLowerCase() === username.toLowerCase(),
  );
  if (exists) throw new ApiError('CONFLICT', '用户名已存在', 409);

  const now = Date.now();
  const account: Account = {
    id: mockId('acc'),
    tenantId: TENANT_ID,
    username,
    displayName,
    role: input.role,
    status: 'active',
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  saveAccounts([...items, account]);
  await recordAudit({ action: 'account.create', targetType: 'account', targetId: account.id });
  return account;
}

/** PATCH /accounts/{id} */
export async function updateAccount(id: string, patch: AccountPatch): Promise<Account> {
  if (!isMockMode) {
    return apiRequest(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  const session = await getSession();
  if (session?.account.id === id) {
    if (patch.status === 'disabled') {
      throw new ApiError('CONFLICT', '不能停用自己的账号', 409);
    }
    if (patch.role && patch.role !== 'admin') {
      throw new ApiError('CONFLICT', '不能降级自己的角色', 409);
    }
  }

  const items = loadAccounts();
  const index = items.findIndex((account) => account.id === id && account.deletedAt === null);
  if (index < 0) throw new ApiError('NOT_FOUND', '账号不存在', 404);
  if (patch.displayName !== undefined && !patch.displayName.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写显示名', 422);
  }
  const next: Account = {
    ...items[index],
    ...patch,
    displayName: patch.displayName?.trim() ?? items[index].displayName,
    updatedAt: Date.now(),
  };
  items[index] = next;
  saveAccounts(items);
  await recordAudit({
    action: 'account.update',
    targetType: 'account',
    targetId: id,
    detail: { role: next.role, status: next.status },
  });
  return next;
}

/** POST /accounts/{id}/reset-password */
export async function resetAccountPassword(id: string, newPassword: string): Promise<void> {
  if (!isMockMode) {
    await apiRequest<void>(`/accounts/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
    return;
  }

  if (!newPassword || newPassword.length < 8) {
    throw new ApiError('VALIDATION_FAILED', '新密码至少 8 位', 422);
  }
  const account = loadAccounts().find((item) => item.id === id && item.deletedAt === null);
  if (!account) throw new ApiError('NOT_FOUND', '账号不存在', 404);
  await recordAudit({ action: 'account.reset_password', targetType: 'account', targetId: id });
}

/** DELETE /accounts/{id}（软删除） */
export async function deleteAccount(id: string): Promise<void> {
  if (!isMockMode) {
    await apiRequest<void>(`/accounts/${id}`, { method: 'DELETE' });
    return;
  }

  const session = await getSession();
  if (session?.account.id === id) {
    throw new ApiError('CONFLICT', '不能删除自己的账号', 409);
  }
  const items = loadAccounts();
  const index = items.findIndex((account) => account.id === id && account.deletedAt === null);
  if (index < 0) throw new ApiError('NOT_FOUND', '账号不存在', 404);
  items[index] = { ...items[index], deletedAt: Date.now(), updatedAt: Date.now() };
  saveAccounts(items);
  await recordAudit({ action: 'account.delete', targetType: 'account', targetId: id });
}

/** GET /accounts/permission-matrix */
export async function getPermissionMatrix(): Promise<PermissionMatrix> {
  if (!isMockMode) return apiRequest('/accounts/permission-matrix');
  return MATRIX;
}

/* ---------- 审计 ---------- */

function filterAudit(items: AuditEvent[], filters: AuditFilters): AuditEvent[] {
  let result = items;
  if (filters.actorType) result = result.filter((item) => item.actorType === filters.actorType);
  if (filters.actorId) result = result.filter((item) => item.actorId === filters.actorId);
  if (filters.action) result = result.filter((item) => item.action === filters.action);
  if (filters.targetType) result = result.filter((item) => item.targetType === filters.targetType);
  if (filters.targetId) result = result.filter((item) => item.targetId === filters.targetId);
  if (filters.result) result = result.filter((item) => item.result === filters.result);
  if (filters.from !== undefined) result = result.filter((item) => item.at >= filters.from!);
  if (filters.to !== undefined) result = result.filter((item) => item.at <= filters.to!);
  if (filters.sandbox !== undefined) result = result.filter((item) => item.sandbox === filters.sandbox);
  return [...result].sort((a, b) => b.at - a.at);
}

/** GET /audit */
export async function listAudit(
  filters: AuditFilters = {},
): Promise<{ items: AuditEvent[]; total: number; page: number; pageSize: number }> {
  if (!isMockMode) {
    return apiRequest(
      `/audit${toQuery({
        actorType: filters.actorType,
        actorId: filters.actorId,
        action: filters.action,
        targetType: filters.targetType,
        targetId: filters.targetId,
        result: filters.result,
        from: filters.from,
        to: filters.to,
        page: filters.page,
        pageSize: filters.pageSize,
      })}`,
    );
  }

  const all = filterAudit(loadAudit(), filters);
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  return {
    items: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
    page,
    pageSize,
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(items: AuditEvent[]): string {
  const header = [
    '时间',
    '操作者类型',
    '操作者',
    '动作',
    '对象类型',
    '对象 ID',
    '结果',
    '错误码',
    'IP',
    '沙盒',
    '详情',
  ];
  const lines = items.map((item) =>
    [
      new Date(item.at).toISOString(),
      item.actorType,
      item.actorName,
      item.action,
      item.targetType,
      item.targetId,
      item.result,
      item.errorCode,
      item.ip,
      item.sandbox ? '是' : '否',
      item.detail ? JSON.stringify(item.detail) : '',
    ]
      .map(csvCell)
      .join(','),
  );
  return `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}`;
}

/** GET /audit/export.csv：返回带 BOM 的 CSV 文本 */
export async function exportAuditCsv(filters: AuditFilters = {}): Promise<string> {
  if (!isMockMode) {
    const response = await fetch(
      `${API_BASE}/audit/export.csv${toQuery({
        actorType: filters.actorType,
        actorId: filters.actorId,
        action: filters.action,
        targetType: filters.targetType,
        targetId: filters.targetId,
        result: filters.result,
        from: filters.from,
        to: filters.to,
      })}`,
      { credentials: 'include' },
    );
    if (!response.ok) {
      throw new ApiError('EXPORT_FAILED', `导出失败（HTTP ${response.status}）`, response.status);
    }
    return response.text();
  }

  const csv = toCsv(filterAudit(loadAudit(), { ...filters, page: undefined, pageSize: undefined }));
  await recordAudit({ action: 'audit.export', targetType: 'audit', targetId: null });
  return csv;
}

export function resetSettingsState(): void {
  writeStore(ACCOUNTS_KEY, accountsFixture);
  writeStore(AUDIT_KEY, auditFixture);
  try {
    localStorage.removeItem(WECOM_KEY);
  } catch {
    // 忽略
  }
}
