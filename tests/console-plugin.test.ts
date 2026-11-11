/**
 * #41 / #39 / #40 / #59 插件装配单测：用假 DSH 上下文验证路由端到端。
 *
 * 不启动真实宿主、不连接企微；存储用内存领域表，患者 Agent 与企微只读入口用假实现。
 * PDF 断言依赖部署机上的中文字体：没有字体时只验证 502 降级，不伪造成功。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../plugins/zhiban-console/index.ts';
import type { DshConsoleContext } from '../plugins/zhiban-console/index.ts';
import { resolvePdfFont } from '../plugins/zhiban-console/pdf.ts';
import type { EvidenceDraftSource } from '../src/p1/evidence.ts';
import { GuardService } from '../src/p1/guard.ts';
import type {
  GuardAlertRecord,
  RiskRuleCreateInput,
  RiskRuleRecord,
  RiskRuleUpdateInput,
} from '../src/p1/guard.ts';
import { KnowledgeService } from '../src/p1/knowledge.ts';
import type {
  KnowledgeCreateInput,
  KnowledgeQuery,
  KnowledgeRecord,
  KnowledgeUpdateInput,
} from '../src/p1/knowledge.ts';
import type { MemoryRecord } from '../src/p1/memory.ts';
import type { AdvisorRecord, ConsentStatus, Patient } from '../src/p1/types.ts';
import type { Draft } from '../src/c2/types.ts';
import type { MealLogRecord } from '../src/p1/vision.ts';

const ADMIN_PASSWORD = 'AdminPass123';
const PLATFORM_PASSWORD = 'PlatformPass123';

class FakeTable {
  readonly map = new Map<string, unknown>();

  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries();
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

class FakeDomain {
  readonly tables = new Map<string, FakeTable>();

  table(name: string): FakeTable {
    let found = this.tables.get(name);
    if (!found) {
      found = new FakeTable();
      this.tables.set(name, found);
    }
    return found;
  }

  async close(): Promise<void> {}
}

class FakeBodyRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket = { remoteAddress: '203.0.113.10' };
  private readonly body: Buffer;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  constructor(init: {
    method: string;
    url: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: Buffer;
  }) {
    this.method = init.method;
    this.url = init.url;
    this.headers = init.headers ?? {};
    this.body = init.body ?? Buffer.alloc(0);
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    if (event === 'end') {
      queueMicrotask(() => {
        this.emit('data', this.body);
        this.emit('end');
      });
    }
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

class FakeWebResponse {
  status = 0;
  headers: Record<string, string | number> = {};
  body = '';
  /** 二进制响应（图片等）原样保留，供断言字节 */
  readonly chunks: Buffer[] = [];
  headersSent = false;
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.status = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    if (typeof chunk !== 'string') this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.write(chunk);
    this.headersSent = true;
    this.resolveDone();
    return this;
  }

  on(): this {
    return this;
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface FakeRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: FakeBodyRequest, res: FakeWebResponse) => unknown;
}

interface PatientApi {
  applySettings(patch: Record<string, unknown>): void;
  sandboxEnsure(patient: unknown): Promise<string>;
  sandboxReset(patient: unknown): Promise<string>;
  sandboxTurn(input: unknown): Promise<void>;
  sandboxInjectContext(sessionId: string, text: string): Promise<void>;
  getPatient(id: string): { id: string; displayName: string } | undefined;
  /** #59：数据安全页 / 服务记录导出 */
  consentStats?(): { agreed: number; unknown: number; disagreed: number; total: number };
  /** #55：饮食记录 */
  listMealLogs?(patientId: string): MealLogRecord[];
  getPatientGroups?(id: string):
    | {
        patient: { id: string; displayName: string };
        groups: Array<{ id: string; name: string; roomId: string }>;
      }
    | undefined;
  /** #60 上线：群列表与状态更新 */
  listGroups?(): FakeGroup[];
  updateGroup?(
    groupId: string,
    patch: { name?: string; status?: string; advisorId?: string },
  ): FakeGroup;
  /** 确认 / 改绑患者身份 */
  setPatientIdentity?(
    groupId: string,
    patientId: string,
    externalUserId: string,
    opts?: { displayName?: string },
  ): Patient;
  /** 服务群成员列表（用于「设为患者」选择） */
  listGroupMembers?(groupId: string): Array<{
    id: string;
    externalUserId?: string;
    externalUserIdTail?: string;
    displayName: string;
    isExternal: boolean;
    role: string;
    consent: string;
  }>;
}

interface FakeGroup {
  id: string;
  roomId: string;
  name: string;
  nameSource: string;
  status: 'pending' | 'serving' | 'collect_only' | 'disabled';
  advisorId?: string;
  patientIds: string[];
  memberCount: number;
  externalMemberCount: number;
  consent: { agreed: number; unknown: number; disagreed: number };
  lastActiveAt?: number;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
}

class FakeConsoleContext {
  readonly provided = new Map<string, unknown>();
  readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  readonly logger = { info: (_line: string): void => undefined };
  readonly domain = new FakeDomain();
  readonly appliedSettings: Array<Record<string, unknown>> = [];
  readonly turns: unknown[] = [];
  route?: FakeRoute;
  effectFn?: () => unknown;
  cleanup?: () => Promise<void>;

  effect(fn: () => unknown): void {
    this.effectFn = fn;
  }

  emit(): void {
    // 控制台自己不经 ctx.emit 广播
  }

  provide(name: string, value: unknown): void {
    this.provided.set(name, value);
  }

  get<T = unknown>(name: string): T | undefined {
    return this.provided.get(name) as T | undefined;
  }

  on(type: string, listener: (data: unknown) => void): () => boolean {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return () => set.delete(listener);
  }

  emitTo(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(data);
  }

  readonly storageDomain = {
    open: async (): Promise<FakeDomain> => this.domain,
  };

  readonly webServer = {
    register: (route: FakeRoute): (() => void) => {
      this.route = route;
      return () => {
        this.route = undefined;
      };
    },
  };

  patientApi: PatientApi = {
    applySettings: (patch) => this.appliedSettings.push(patch),
    sandboxEnsure: async () => 'sess_sandbox_1',
    sandboxReset: async () => 'sess_sandbox_2',
    sandboxTurn: async (input) => {
      this.turns.push(input);
    },
    sandboxInjectContext: async () => undefined,
    getPatient: () => undefined,
  };

  async start(): Promise<void> {
    const cleanup = await this.effectFn?.();
    if (typeof cleanup === 'function') {
      this.cleanup = cleanup as () => Promise<void>;
    }
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tn_test',
    tenant: { name: '安康健康管理中心', agentName: '小安' },
    admin: { username: 'admin', displayName: '林主管', password: ADMIN_PASSWORD },
    platform: { username: 'platform', displayName: '平台运营', password: PLATFORM_PASSWORD },
    cookieSecure: false,
    allowedOrigins: ['https://console.example.com'],
    ...overrides,
  };
}

async function start(overrides: Record<string, unknown> = {}) {
  const ctx = new FakeConsoleContext();
  ctx.provide('zhibanPatient', ctx.patientApi);
  apply(ctx as unknown as DshConsoleContext, config(overrides));
  await ctx.start();
  assert.ok(ctx.route);

  const call = async (
    method: string,
    path: string,
    options: {
      body?: unknown;
      cookie?: string;
      headers?: Record<string, string>;
      rawBody?: Buffer;
    } = {},
  ) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie) headers.cookie = options.cookie;
    let body: Buffer | undefined;
    if (options.rawBody) {
      body = options.rawBody;
    } else if (options.body !== undefined) {
      body = Buffer.from(JSON.stringify(options.body));
      headers['content-type'] = 'application/json';
    }
    const req = new FakeBodyRequest({ method, url: path, headers, body });
    const res = new FakeWebResponse();
    ctx.route!.handler(req, res);
    await res.done;
    return res;
  };

  return { ctx, call };
}

/** 从 Set-Cookie 里取出可直接回传的 Cookie 头 */
function cookieOf(res: FakeWebResponse): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  assert.ok(raw.includes('HttpOnly'));
  assert.ok(raw.includes('SameSite=Lax'));
  assert.ok(raw.includes('Max-Age=604800'));
  return raw.split(';')[0]!;
}

async function login(call: Awaited<ReturnType<typeof start>>['call'], username: string, password: string) {
  const res = await call('POST', '/zhiban/api/auth/login', { body: { username, password } });
  assert.equal(res.status, 200);
  return { res, cookie: cookieOf(res) };
}

test('登录 → 会话 → 租户读取/修改（保存即生效到患者运行时）', async () => {
  const { ctx, call } = await start();

  const unauthenticated = await call('GET', '/zhiban/api/auth/session');
  assert.equal(unauthenticated.status, 401);

  const bad = await call('POST', '/zhiban/api/auth/login', {
    body: { username: 'admin', password: 'WrongPass123' },
  });
  assert.equal(bad.status, 401);
  assert.equal((bad.json() as { error: { code: string } }).error.code, 'INVALID_CREDENTIALS');

  const { res, cookie } = await login(call, 'admin', ADMIN_PASSWORD);
  const loginBody = res.json() as { account: Record<string, unknown>; tenant: Record<string, unknown> };
  assert.equal(loginBody.account.role, 'admin');
  assert.equal('passwordHash' in loginBody.account, false);
  assert.equal(loginBody.tenant.id, 'tn_test');

  const session = await call('GET', '/zhiban/api/auth/session', { cookie });
  assert.equal(session.status, 200);
  const sessionBody = session.json() as { permissions: string[]; tenant: { name: string } };
  assert.equal(sessionBody.tenant.name, '安康健康管理中心');
  assert.ok(sessionBody.permissions.includes('tenant.write'));

  const patched = await call('PATCH', '/zhiban/api/tenant', {
    cookie,
    body: { agentName: '小新', tone: '耐心、简短', settings: { writeMinutesPerDraft: 5 } },
  });
  assert.equal(patched.status, 200);
  const tenant = patched.json() as {
    agentName: string;
    tone: string;
    settings: { writeMinutesPerDraft: number };
  };
  assert.equal(tenant.agentName, '小新');
  assert.equal(tenant.tone, '耐心、简短');
  assert.equal(tenant.settings.writeMinutesPerDraft, 5);
  assert.deepEqual(ctx.appliedSettings.at(-1), {
    agentName: '小新',
    patientTerm: '患者',
    tone: '耐心、简短',
  });

  const audited = await call('GET', '/zhiban/api/audit?action=tenant.update', { cookie });
  assert.equal(audited.status, 200);
  assert.equal((audited.json() as { total: number }).total, 1);
});

test('#60 群管理：列表过滤/排序、状态更新、审计与写权限', async () => {
  const { ctx, call } = await start();
  const base = {
    roomId: 'wr_demo_1',
    nameSource: 'config',
    advisorId: 'adv_1',
    patientIds: ['pat_1'],
    memberCount: 2,
    externalMemberCount: 1,
    consent: { agreed: 1, unknown: 0, disagreed: 0 },
    demo: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  const groups: FakeGroup[] = [
    { ...base, id: 'grp_1', name: '陈嘉禾', status: 'pending', lastActiveAt: 2_000 },
    {
      ...base,
      id: 'grp_2',
      roomId: 'wr_demo_2',
      name: '周敏',
      status: 'serving',
      lastActiveAt: 1_000,
    },
  ];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  ctx.patientApi.listGroups = () => groups;
  ctx.patientApi.updateGroup = (groupId, patch) => {
    updates.push({ id: groupId, patch });
    const group = groups.find((item) => item.id === groupId);
    assert.ok(group);
    if (patch.name !== undefined) group.name = patch.name;
    if (patch.status !== undefined) group.status = patch.status as FakeGroup['status'];
    if (patch.advisorId !== undefined) group.advisorId = patch.advisorId;
    group.updatedAt += 1;
    return group;
  };
  // #106：服务状态变更应同步到企微存档白名单
  const serviceCalls: Array<{ action: string; roomId: string }> = [];
  ctx.provide('zhibanWecomAdmin', {
    releaseQueue: async () => ({ releasedDraftId: 'draft_0', nextDraftId: null }),
    restoreAdvisor: () => ({
      id: 'adv_1',
      name: '顾问',
      status: 'active',
      consecutiveMisroutes: 0,
    }),
    activateServiceGroup: ({ roomId }: { roomId: string }) => {
      serviceCalls.push({ action: 'activate', roomId });
      return { roomId, name: '群', allowed: true };
    },
    deactivateServiceGroup: (roomId: string) => {
      serviceCalls.push({ action: 'deactivate', roomId });
      return { roomId, allowed: false };
    },
  });

  const admin = await login(call, 'admin', ADMIN_PASSWORD);
  const pending = await call('GET', '/zhiban/api/groups?status=pending', { cookie: admin.cookie });
  assert.equal(pending.status, 200);
  const pendingBody = pending.json() as { items: FakeGroup[]; total: number };
  assert.equal(pendingBody.total, 1);
  assert.equal(pendingBody.items[0]!.name, '陈嘉禾');

  const sorted = await call('GET', '/zhiban/api/groups?sort=name', { cookie: admin.cookie });
  assert.equal(sorted.status, 200);
  assert.deepEqual(
    (sorted.json() as { items: FakeGroup[] }).items.map((item) => item.name),
    ['陈嘉禾', '周敏'],
  );

  const badSort = await call('GET', '/zhiban/api/groups?sort=password', { cookie: admin.cookie });
  assert.equal(badSort.status, 422);

  const patched = await call('PATCH', '/zhiban/api/groups/grp_1', {
    cookie: admin.cookie,
    body: { status: 'serving', name: '陈嘉禾（演示）' },
  });
  assert.equal(patched.status, 200);
  const patchedBody = patched.json() as unknown as FakeGroup;
  assert.equal(patchedBody.status, 'serving');
  assert.equal(patchedBody.name, '陈嘉禾（演示）');
  assert.deepEqual(updates[0], {
    id: 'grp_1',
    patch: { name: '陈嘉禾（演示）', status: 'serving' },
  });
  assert.deepEqual(serviceCalls, [{ action: 'activate', roomId: 'wr_demo_1' }]);

  const stopped = await call('PATCH', '/zhiban/api/groups/grp_2', {
    cookie: admin.cookie,
    body: { status: 'disabled' },
  });
  assert.equal(stopped.status, 200);
  assert.deepEqual(serviceCalls.at(-1), { action: 'deactivate', roomId: 'wr_demo_2' });

  const audit = await call('GET', '/zhiban/api/audit?action=group.update', { cookie: admin.cookie });
  assert.equal((audit.json() as { total: number }).total, 2);

  const badStatus = await call('PATCH', '/zhiban/api/groups/grp_1', {
    cookie: admin.cookie,
    body: { status: 'sleeping' },
  });
  assert.equal(badStatus.status, 422);

  const created = await call('POST', '/zhiban/api/accounts', {
    cookie: admin.cookie,
    body: {
      username: 'viewer.groups',
      displayName: '只读二号',
      role: 'viewer',
      password: 'ViewerPass456',
    },
  });
  assert.equal(created.status, 201);
  const viewer = await login(call, 'viewer.groups', 'ViewerPass456');
  const readable = await call('GET', '/zhiban/api/groups', { cookie: viewer.cookie });
  assert.equal(readable.status, 200);
  const forbidden = await call('PATCH', '/zhiban/api/groups/grp_1', {
    cookie: viewer.cookie,
    body: { status: 'serving' },
  });
  assert.equal(forbidden.status, 403);
});

test('非法 Origin 被拒；白名单来源与无 Origin 放行', async () => {
  const { call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const evil = await call('PATCH', '/zhiban/api/tenant', {
    cookie,
    headers: { origin: 'https://evil.example.com' },
    body: { tone: '正常' },
  });
  assert.equal(evil.status, 403);

  const allowed = await call('PATCH', '/zhiban/api/tenant', {
    cookie,
    headers: { origin: 'https://console.example.com', host: 'console.example.com' },
    body: { tone: '正常' },
  });
  assert.equal(allowed.status, 200);

  const sameOrigin = await call('POST', '/zhiban/api/auth/logout', {
    cookie,
    headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
  });
  assert.equal(sameOrigin.status, 204);
  assert.match(String(sameOrigin.headers['set-cookie']), /Max-Age=0/);

  const expired = await call('GET', '/zhiban/api/auth/session', { cookie });
  assert.equal(expired.status, 401);
});

test('账号管理：创建只读账号，权限矩阵限制写操作，密码不泄漏', async () => {
  const { call } = await start();
  const admin = await login(call, 'admin', ADMIN_PASSWORD);

  const created = await call('POST', '/zhiban/api/accounts', {
    cookie: admin.cookie,
    body: {
      username: 'viewer.one',
      displayName: '只读一号',
      role: 'viewer',
      password: 'ViewerPass123',
    },
  });
  assert.equal(created.status, 201);
  const createdBody = created.json() as Record<string, unknown>;
  assert.equal(createdBody.username, 'viewer.one');
  assert.equal('passwordHash' in createdBody, false);

  const matrix = await call('GET', '/zhiban/api/accounts/permission-matrix', {
    cookie: admin.cookie,
  });
  assert.equal(matrix.status, 200);
  const matrixBody = matrix.json() as { roles: Array<{ role: string; permissions: string[] }> };
  assert.deepEqual(matrixBody.roles.map((role) => role.role), ['admin', 'supervisor', 'viewer']);

  const viewer = await login(call, 'viewer.one', 'ViewerPass123');
  const forbidden = await call('PATCH', '/zhiban/api/tenant', {
    cookie: viewer.cookie,
    body: { tone: '越权' },
  });
  assert.equal(forbidden.status, 403);

  const canReadAlerts = await call('GET', '/zhiban/api/alerts', { cookie: viewer.cookie });
  assert.equal(canReadAlerts.status, 200);

  const list = await call('GET', '/zhiban/api/accounts', { cookie: admin.cookie });
  assert.equal(list.status, 200);
  const listBody = list.json() as { total: number; items: Array<Record<string, unknown>> };
  assert.equal(listBody.total, 2);
  assert.equal(listBody.items.some((item) => 'passwordHash' in item), false);
});

test('平台账号访问租户接口一律 404', async () => {
  const { call } = await start();
  const platform = await login(call, 'platform', PLATFORM_PASSWORD);
  for (const path of ['/zhiban/api/tenant', '/zhiban/api/alerts', '/zhiban/api/audit']) {
    const res = await call('GET', path, { cookie: platform.cookie });
    assert.equal(res.status, 404, path);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'NOT_FOUND');
  }
});

test('告警事件入库、列表、详情、处理；重复处理 409，已解决计数扣除', async () => {
  const { ctx, call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  ctx.emitTo('alert.created', {
    kind: 'MISROUTE',
    message: '发错群',
    advisorId: 'adv_1',
    draftId: 'draft_1',
  });
  ctx.emitTo('alert.created', { kind: 'UNKNOWN' });

  const list = await call('GET', '/zhiban/api/alerts', { cookie });
  assert.equal(list.status, 200);
  const listBody = list.json() as { total: number; items: Array<{ id: string; kind: string }> };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0]!.kind, 'misroute');
  const alertId = listBody.items[0]!.id;

  const count = await call('GET', '/zhiban/api/alerts/unresolved-count', { cookie });
  assert.deepEqual(count.json(), { open: 1, acknowledged: 0, total: 1 });

  const detail = await call('GET', `/zhiban/api/alerts/${alertId}`, { cookie });
  assert.equal(detail.status, 200);
  const detailBody = detail.json() as { alert: { id: string }; draft: unknown; advisor: unknown };
  assert.equal(detailBody.alert.id, alertId);
  assert.equal(detailBody.draft, null);
  assert.equal(detailBody.advisor, null);

  const resolved = await call('POST', `/zhiban/api/alerts/${alertId}/resolve`, {
    cookie,
    body: { note: '已与顾问确认' },
  });
  assert.equal(resolved.status, 200);
  assert.equal((resolved.json() as { status: string }).status, 'resolved');

  const again = await call('POST', `/zhiban/api/alerts/${alertId}/resolve`, {
    cookie,
    body: { note: '重复' },
  });
  assert.equal(again.status, 409);

  const after = await call('GET', '/zhiban/api/alerts/unresolved-count', { cookie });
  assert.deepEqual(after.json(), { open: 0, acknowledged: 0, total: 0 });
});

test('Idempotency-Key 使重复的写操作返回缓存结果', async () => {
  const { ctx, call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);
  ctx.emitTo('alert.created', { kind: 'remind' });
  const list = await call('GET', '/zhiban/api/alerts', { cookie });
  const alertId = (list.json() as { items: Array<{ id: string }> }).items[0]!.id;

  const headers = { 'idempotency-key': 'test-key-1' };
  const first = await call('POST', `/zhiban/api/alerts/${alertId}/resolve`, {
    cookie,
    headers,
    body: { note: '处理完成' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-idempotent-replay'], undefined);

  const second = await call('POST', `/zhiban/api/alerts/${alertId}/resolve`, {
    cookie,
    headers,
    body: { note: '处理完成' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers['x-idempotent-replay'], 'true');
  assert.deepEqual(second.json(), first.json());
});

test('沙盒：建会话、发消息、sink 草稿、四种动作与状态', async () => {
  const { ctx, call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const created = await call('POST', '/zhiban/api/sandbox/session', { cookie });
  assert.equal(created.status, 200);
  const view = created.json() as {
    session: { id: string; patient: { id: string } };
    quota: { usedToday: number };
  };
  assert.match(view.session.patient.id, /^pat_sandbox_/);

  const posted = await call('POST', '/zhiban/api/sandbox/messages', {
    cookie,
    body: { kind: 'text', text: '我对海鲜过敏' },
  });
  assert.equal(posted.status, 202);
  assert.equal((posted.json() as { quota: { usedToday: number } }).quota.usedToday, 1);

  // 患者运行时把草稿交回控制台的 sink
  const sink = ctx.provided.get('zhibanSandboxSink') as {
    enqueueDraft(input: Record<string, unknown>): { draftId: string; version: number };
  };
  const draft = sink.enqueueDraft({
    sessionId: 'sess_sandbox_1',
    patientId: view.session.patient.id,
    groupId: 'grp_sandbox_acc_1',
    groupName: '体验客户群',
    body: '晚餐避开海鲜。',
    inboundSummary: '患者对海鲜过敏',
    riskLevel: 'low',
    fallback: false,
  });
  assert.match(draft.draftId, /^draft_sbx_/);

  const state = await call('GET', '/zhiban/api/sandbox/state', { cookie });
  assert.equal(state.status, 200);
  const stateBody = state.json() as { messages: unknown[]; drafts: Array<{ id: string; status: string }> };
  assert.equal(stateBody.messages.length, 1);
  assert.equal(stateBody.drafts.length, 1);
  assert.equal(stateBody.drafts[0]!.status, 'PUSHED');

  const action = await call('POST', `/zhiban/api/sandbox/drafts/${draft.draftId}/actions`, {
    cookie,
    body: { action: 'send_original' },
  });
  assert.equal(action.status, 200);
  assert.equal((action.json() as { outcome: string }).outcome, 'verified');

  const reset = await call('POST', '/zhiban/api/sandbox/session/reset', { cookie });
  assert.equal(reset.status, 200);
  assert.equal((reset.json() as { quota: { usedToday: number } }).quota.usedToday, 1);

  const afterReset = await call('GET', '/zhiban/api/sandbox/state', { cookie });
  assert.equal((afterReset.json() as { messages: unknown[] }).messages.length, 0);
});

test('审计 CSV 导出带 BOM 与表头，并记录导出动作', async () => {
  const { call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const csv = await call('GET', '/zhiban/api/audit/export.csv?result=success', { cookie });
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers['content-type']), /^text\/csv/);
  assert.match(String(csv.headers['content-disposition']), /attachment/);
  assert.equal(csv.body.startsWith('﻿'), true);
  assert.match(csv.body, /id,tenantId,actorType,actorId,actorName,action/);
  assert.equal(csv.body.includes('auth.login'), true);

  const audits = await call('GET', '/zhiban/api/audit?action=audit.export', { cookie });
  assert.equal((audits.json() as { total: number }).total, 1);
});

test('未知路径 404、错误方法 405；卸载时释放路由', async () => {
  const { ctx, call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const missing = await call('GET', '/zhiban/api/nope', { cookie });
  assert.equal(missing.status, 404);
  const wrongMethod = await call('DELETE', '/zhiban/api/tenant', { cookie });
  assert.equal(wrongMethod.status, 405);

  await ctx.cleanup?.();
});

// ---------- #59 数据与安全 / 证据链导出 ----------

function draftSource(overrides: Partial<EvidenceDraftSource> = {}): EvidenceDraftSource {
  return {
    id: 'draft_1',
    advisorId: 'adv_1',
    advisorName: '陈顾问',
    groupRoomId: 'room_1',
    groupName: '康养服务群',
    customerName: '张女士',
    inboundSummary: '客户询问晚餐怎么吃',
    inboundMessageIds: ['m_in_1'],
    mediaIds: [],
    body: '晚餐清淡一点，避开海鲜。',
    version: 2,
    revisions: [
      { version: 1, body: '晚餐清淡一点。', createdBy: 'agent', createdAt: 1_700_000_000_000 },
      {
        version: 2,
        body: '晚餐清淡一点，避开海鲜。',
        instruction: '加上忌口提醒',
        createdBy: 'staff',
        createdAt: 1_700_000_100_000,
      },
    ],
    status: 'VERIFIED',
    riskLevel: 'low',
    sentVersion: 2,
    verification: {
      outcome: 'VERIFIED',
      matchedMsgId: 'm_sent_1',
      matchedRoomId: 'room_1',
      similarity: 1,
      checkedAt: 1_700_000_200_000,
    },
    ackAction: 'sent',
    ackAt: 1_700_000_200_000,
    createdAt: 1_700_000_000_000,
    pushedAt: 1_700_000_050_000,
    citedMemoryIds: [],
    citedKnowledgeIds: ['kb_1'],
    inbound: [
      {
        msgid: 'm_in_1',
        from: 'wx_customer',
        text: '晚上能吃海鲜吗？',
        msgtime: 1_700_000_000_000,
      },
    ],
    sent: { msgid: 'm_sent_1', text: '晚餐清淡一点，避开海鲜。', msgtime: 1_700_000_200_000 },
    ...overrides,
  };
}

function installEvidencePorts(ctx: FakeConsoleContext): void {
  ctx.provide('zhibanWecomAdmin', {
    async getDraftEvidence(draftId: string) {
      return draftId === 'draft_1' ? draftSource() : undefined;
    },
    async listDraftsByRooms() {
      return [draftSource()];
    },
  });
  ctx.patientApi.consentStats = () => ({ agreed: 2, unknown: 1, disagreed: 0, total: 3 });
  ctx.patientApi.getPatientGroups = (id) =>
    id === 'pat_1'
      ? {
          patient: { id: 'pat_1', displayName: '张女士' },
          groups: [{ id: 'grp_1', name: '康养服务群', roomId: 'room_1' }],
        }
      : undefined;
}

test('数据与安全页：部署事实、留存口径、同意统计、角色与导出计数来自实时数据', async () => {
  const { ctx, call } = await start();
  installEvidencePorts(ctx);
  const admin = await login(call, 'admin', ADMIN_PASSWORD);

  const forbidden = await call('GET', '/zhiban/api/settings/security');
  assert.equal(forbidden.status, 401);

  const res = await call('GET', '/zhiban/api/settings/security', { cookie: admin.cookie });
  assert.equal(res.status, 200);
  const body = res.json() as {
    deployment: {
      dataRegion: string;
      modelRegion: string;
      modelService: string;
      transport: string;
      dataStores: string[];
    };
    retention: { notice: string; autoDelete: boolean };
    consent: { agreed: number; unknown: number; disagreed: number; total: number };
    access: { roles: Array<{ role: string; permissions: string[] }> };
    audit: { events30d: number; exports30d: number; lastExportAt: number | null };
    pdf: { fontConfigured: boolean };
  };
  assert.equal(body.deployment.dataRegion, '中国大陆境内');
  assert.equal(body.deployment.modelService, 'DeepSeek（境内）');
  assert.match(body.deployment.transport, /HTTP/); // 测试配置 cookieSecure:false
  assert.ok(body.deployment.dataStores.length >= 2);
  assert.equal(body.retention.notice, '按合同约定；当前演示环境不自动删除');
  assert.equal(body.retention.autoDelete, false);
  assert.deepEqual(body.consent, { agreed: 2, unknown: 1, disagreed: 0, total: 3 });
  assert.deepEqual(
    body.access.roles.map((role) => role.role),
    ['admin', 'supervisor', 'viewer'],
  );
  assert.equal(body.access.roles.find((role) => role.role === 'viewer')!.permissions.includes('export'), false);
  assert.equal(body.audit.exports30d, 0);
  assert.equal(body.pdf.fontConfigured, resolvePdfFont({}) !== undefined);

  // 只读账号可看页面，但不能导出
  const created = await call('POST', '/zhiban/api/accounts', {
    cookie: admin.cookie,
    body: { username: 'viewer.sec', displayName: '只读二号', role: 'viewer', password: 'ViewerPass123' },
  });
  assert.equal(created.status, 201);
  const viewer = await login(call, 'viewer.sec', 'ViewerPass123');
  const viewerOverview = await call('GET', '/zhiban/api/settings/security', { cookie: viewer.cookie });
  assert.equal(viewerOverview.status, 200);

  const viewerExport = await call('GET', '/zhiban/api/drafts/draft_1/evidence.pdf', {
    cookie: viewer.cookie,
  });
  assert.equal(viewerExport.status, 403);
});

test('证据链 PDF：权限、404、字体缺失降级与导出审计', async () => {
  const { ctx, call } = await start();
  installEvidencePorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const unauth = await call('GET', '/zhiban/api/drafts/draft_1/evidence.pdf');
  assert.equal(unauth.status, 401);

  const unknown = await call('GET', '/zhiban/api/drafts/draft_404/evidence.pdf', { cookie });
  assert.equal(unknown.status, 404);
  assert.equal((unknown.json() as { error: { code: string } }).error.code, 'NOT_FOUND');

  const font = resolvePdfFont({});
  const pdf = await call('GET', '/zhiban/api/drafts/draft_1/evidence.pdf', { cookie });
  if (!font) {
    assert.equal(pdf.status, 502);
    assert.equal((pdf.json() as { error: { code: string } }).error.code, 'UPSTREAM_UNAVAILABLE');
  } else {
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(String(pdf.headers['content-disposition']), /filename="evidence-draft_1\.pdf"/);
    assert.match(pdf.body, /^%PDF-1\./);
  }

  const audit = await call('GET', '/zhiban/api/audit?action=evidence.export', { cookie });
  assert.equal((audit.json() as { total: number }).total, font ? 1 : 0);
});

test('证据链 PDF：企微插件未就绪时返回 502，不产生审计', async () => {
  const { call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const res = await call('GET', '/zhiban/api/drafts/draft_1/evidence.pdf', { cookie });
  assert.equal(res.status, 502);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'UPSTREAM_UNAVAILABLE');
  const audit = await call('GET', '/zhiban/api/audit?action=evidence.export', { cookie });
  assert.equal((audit.json() as { total: number }).total, 0);
});

test('患者服务记录 PDF：时间范围校验、404、导出审计与文件名', async () => {
  const { ctx, call } = await start();
  installEvidencePorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const unknown = await call('GET', '/zhiban/api/patients/pat_404/records.pdf', { cookie });
  assert.equal(unknown.status, 404);

  const invalid = await call('GET', '/zhiban/api/patients/pat_1/records.pdf?from=2000&to=1000', {
    cookie,
  });
  assert.equal(invalid.status, 422);
  assert.equal((invalid.json() as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

  const font = resolvePdfFont({});
  const pdf = await call('GET', '/zhiban/api/patients/pat_1/records.pdf', { cookie });
  if (!font) {
    assert.equal(pdf.status, 502);
  } else {
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(String(pdf.headers['content-disposition']), /filename="records-pat_1\.pdf"/);
    assert.match(pdf.body, /^%PDF-1\./);
  }

  const audit = await call('GET', '/zhiban/api/audit?action=records.export', { cookie });
  assert.equal((audit.json() as { total: number }).total, font ? 1 : 0);
});

test('#55 饮食记录：按患者读取、时间过滤、分页，照片经鉴权接口回读且不暴露服务器路径', async () => {
  const { ctx, call } = await start();
  ctx.patientApi.getPatient = (id) =>
    id === 'pat_1' ? { id: 'pat_1', displayName: '张女士' } : undefined;
  // 存档里扩展名不可信：真实文件是 PNG，路径故意写成 .jpg
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
  ]);
  const photoDir = await mkdtemp(join(tmpdir(), 'zhiban-meal-'));
  const photoPath = join(photoDir, 'dinner.jpg');
  await writeFile(photoPath, png);

  const records: MealLogRecord[] = [
    {
      id: 'meal_2',
      tenantId: 'tn_test',
      patientId: 'pat_1',
      groupId: 'grp_1',
      messageId: 'msg_2',
      mediaPath: photoPath,
      mealType: 'dinner',
      foods: [{ name: '清蒸鲈鱼', portion: '约 150g' }],
      confidence: 0.9,
      sandbox: false,
      createdAt: 1_700_000_200_000,
    },
    {
      id: 'meal_1',
      tenantId: 'tn_test',
      patientId: 'pat_1',
      groupId: 'grp_1',
      mealType: 'lunch',
      foods: [{ name: '番茄炒蛋' }],
      confidence: 0.7,
      sandbox: false,
      createdAt: 1_700_000_000_000,
    },
  ];
  ctx.patientApi.listMealLogs = (patientId) =>
    patientId === 'pat_1' ? records : [];
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const all = await call('GET', '/zhiban/api/patients/pat_1/meal-logs', { cookie });
  assert.equal(all.status, 200);
  const body = all.json() as { items: Array<Record<string, unknown>>; total: number };
  assert.equal(body.total, 2);
  assert.equal(body.items[0]!.id, 'meal_2');
  assert.equal(body.items[0]!.photoUrl, '/zhiban/api/patients/pat_1/meal-logs/meal_2/photo');
  assert.equal(body.items[1]!.photoUrl, null);
  assert.equal(JSON.stringify(body).includes(photoDir), false);
  assert.equal(JSON.stringify(body).includes('.jpg'), false);

  const photo = await call('GET', '/zhiban/api/patients/pat_1/meal-logs/meal_2/photo', { cookie });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers['content-type'], 'image/png');
  assert.deepEqual(photo.bytes(), png);

  // 没有原图或日志不存在的记录返回 404，不拼路径探测
  const noPhoto = await call('GET', '/zhiban/api/patients/pat_1/meal-logs/meal_1/photo', {
    cookie,
  });
  assert.equal(noPhoto.status, 404);
  const unknownPhoto = await call('GET', '/zhiban/api/patients/pat_1/meal-logs/meal_404/photo', {
    cookie,
  });
  assert.equal(unknownPhoto.status, 404);

  const ranged = await call(
    'GET',
    '/zhiban/api/patients/pat_1/meal-logs?from=1700000100000&to=1700000300000&page=1&pageSize=10',
    { cookie },
  );
  assert.equal(ranged.status, 200);
  const rangedBody = ranged.json() as { items: Array<Record<string, unknown>>; total: number };
  assert.equal(rangedBody.total, 1);
  assert.equal(rangedBody.items[0]!.mealType, 'dinner');

  const missing = await call('GET', '/zhiban/api/patients/pat_404/meal-logs', { cookie });
  assert.equal(missing.status, 404);
});

// ---------- 真实数据回填：工作台 / 患者 / 顾问 / 服务流（P1-api §4–§8） ----------

function realPatient(overrides: Partial<Patient> = {}): Patient {
  const at = Date.now() - 5 * 60_000;
  return {
    id: 'pat_1',
    tenantId: 'tn_test',
    displayName: '汪女士',
    externalUserId: 'wm_test_1',
    tags: [],
    advisorId: 'adv_1',
    consent: 'agreed',
    status: 'serving',
    demo: false,
    accompaniedSince: at,
    lastActiveAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function realAdvisor(overrides: Partial<AdvisorRecord> = {}): AdvisorRecord {
  const at = Date.now() - 5 * 60_000;
  return {
    id: 'adv_1',
    tenantId: 'tn_test',
    wecomUserId: 'LiGuang',
    name: '李广',
    status: 'active',
    chatBound: true,
    consecutiveMisroutes: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function realDraft(overrides: Partial<Draft> = {}): Draft {
  const at = Date.now() - 5 * 60_000;
  return {
    id: 'draft_1',
    advisorId: 'adv_1',
    groupRoomId: 'room_1',
    groupName: '客户-汪女士',
    customerId: 'wm_test_1',
    customerName: '汪女士',
    lastInboundAt: at,
    inboundMessageId: 'm_1',
    inboundMessageIds: ['m_1'],
    inboundSummary: '客户问晚餐怎么吃',
    body: '晚餐清淡一点。',
    ruleIds: [],
    riskLevel: 'low',
    status: 'QUEUED',
    version: 1,
    revisions: [{ version: 1, body: '晚餐清淡一点。', createdBy: 'agent', createdAt: at }],
    source: 'inbound',
    fallback: false,
    citedMemoryIds: [],
    citedKnowledgeIds: [],
    createdAt: at,
    queuedAt: at,
    nextAttemptAt: at,
    pushAttempts: 1,
    verifyAttempts: 0,
    ...overrides,
  };
}

function installRealDataPorts(ctx: FakeConsoleContext): {
  patients: Patient[];
  advisor: AdvisorRecord;
  drafts: Draft[];
  paused: string[];
  memories: MemoryRecord[];
} {
  const patients = [
    realPatient(),
    realPatient({
      id: 'pat_2',
      displayName: '示例患者',
      externalUserId: 'wm_demo_2',
      demo: true,
    }),
  ];
  const advisor = realAdvisor();
  const memories: MemoryRecord[] = [
    {
      id: 'mem_1',
      tenantId: 'tn_test',
      patientId: 'pat_1',
      category: 'preference',
      content: '晚餐不吃海鲜',
      subject: 'self',
      createdBy: 'agent',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      sandbox: false,
    },
  ];
  const drafts = [
    realDraft({
      id: 'draft_1',
      status: 'VERIFIED',
      version: 2,
      revisions: [
        { version: 1, body: '晚餐清淡一点。', createdBy: 'agent', createdAt: Date.now() - 5 * 60_000 },
        {
          version: 2,
          body: '晚餐清淡一点，避开海鲜。',
          instruction: '加上忌口提醒',
          createdBy: 'staff',
          createdAt: Date.now() - 4 * 60_000,
        },
      ],
      sentVersion: 2,
      ackAction: 'sent',
      ackAt: Date.now() - 3 * 60_000,
      verification: {
        outcome: 'VERIFIED',
        matchedMsgId: 'm_sent_1',
        matchedRoomId: 'room_1',
        similarity: 1,
        checkedAt: Date.now() - 2 * 60_000,
      },
      citedMemoryIds: ['mem_1'],
      citedKnowledgeIds: ['kb_1'],
      mediaIds: ['/var/lib/zhiban/archive/media/meal.jpg'],
      mediaKinds: ['meal'],
    }),
    realDraft({
      id: 'draft_2',
      customerId: 'wm_other',
      customerName: '另一位客户',
      lastInboundAt: Date.now() - 7 * 60_000,
      createdAt: Date.now() - 6 * 60_000,
      status: 'VERIFIED',
      ackAction: 'sent',
      ackAt: Date.now() - 3 * 60_000,
      verification: {
        outcome: 'VERIFIED',
        matchedMsgId: 'm_sent_2',
        matchedRoomId: 'room_1',
        similarity: 1,
        checkedAt: Date.now() - 2 * 60_000,
      },
    }),
    realDraft({ id: 'draft_3', status: 'SKIPPED', ackAction: 'skipped', createdAt: Date.now() - 7 * 60_000 }),
    realDraft({ id: 'draft_4', status: 'QUEUED', createdAt: Date.now() - 8 * 60_000 }),
  ];
  const paused: string[] = [];

  Object.assign(ctx.patientApi, {
    listPatients: () => patients,
    getPatientAdmin: (id: string) => patients.find((patient) => patient.id === id),
    listAdvisors: () => [advisor],
    getAdvisor: (id: string) => (id === advisor.id ? advisor : undefined),
    getPatientBindings: (id: string) =>
      id === 'pat_1' ? [{ groupId: 'grp_1', isPrimary: true }] : [],
    updatePatient: (id: string, patch: Partial<Patient>) => {
      const index = patients.findIndex((patient) => patient.id === id);
      patients[index] = { ...patients[index]!, ...patch, updatedAt: Date.now() };
      return patients[index]!;
    },
    updateAdvisor: (id: string, patch: Partial<AdvisorRecord>) => {
      if (id !== advisor.id) throw new Error('ADVISOR_NOT_FOUND');
      Object.assign(advisor, patch, { updatedAt: Date.now() });
      return advisor;
    },
    createPatient: (input: {
      displayName: string;
      externalUserId?: string;
      tags?: string[];
      advisorId?: string;
      consent?: ConsentStatus;
    }) => {
      const created = realPatient({
        id: `pat_new_${patients.length + 1}`,
        displayName: input.displayName,
        externalUserId: input.externalUserId,
        advisorId: input.advisorId,
        demo: false,
        tags: input.tags ?? [],
        consent: input.consent ?? 'unknown',
      });
      patients.push(created);
      return created;
    },
    bindPatient: (groupId: string, patientId: string, isPrimary = false) => ({
      id: `gbd_${patients.length}_${groupId}`,
      tenantId: 'tn_test',
      groupId,
      patientId,
      isPrimary,
      createdAt: Date.now(),
    }),
    listGroups: () => [
      {
        id: 'grp_1',
        roomId: 'room_1',
        name: '客户-汪女士',
        nameSource: 'manual',
        status: 'serving',
        advisorId: 'adv_1',
        memberCount: 3,
        externalMemberCount: 1,
        demo: false,
        createdAt: Date.now() - 86_400_000,
        updatedAt: Date.now() - 86_400_000,
      },
    ],
    listGroupMembers: (groupId: string) => {
      if (groupId !== 'grp_1') throw new Error('GROUP_NOT_FOUND');
      return [
        {
          id: 'gm_1',
          externalUserId: 'wm_test_1',
          externalUserIdTail: '…test_1',
          displayName: '汪女士',
          isExternal: true,
          role: 'self',
          consent: 'agreed',
        },
        {
          id: 'gm_2',
          externalUserId: 'wm_family_1',
          externalUserIdTail: '…ily_1',
          displayName: '家人小张',
          isExternal: true,
          role: 'family',
          consent: 'unknown',
        },
        {
          id: 'gm_3',
          staffUserId: 'LiGuang',
          displayName: '李光',
          isExternal: false,
          role: 'advisor',
          consent: 'agreed',
        },
      ];
    },
    setPatientIdentity: (
      groupId: string,
      patientId: string,
      externalUserId: string,
      opts: { displayName?: string } = {},
    ) => {
      if (groupId !== 'grp_1') throw new Error('NOT_BOUND');
      const index = patients.findIndex((patient) => patient.id === patientId);
      if (index < 0) throw new Error('PATIENT_NOT_FOUND');
      if (!['wm_test_1', 'wm_family_1'].includes(externalUserId)) {
        throw new Error('MEMBER_NOT_EXTERNAL');
      }
      const updated = {
        ...patients[index]!,
        externalUserId,
        identityStatus: 'confirmed' as const,
        identitySource: 'manual' as const,
        identityConfirmedAt: Date.now(),
        displayName: opts.displayName ?? (externalUserId === 'wm_test_1' ? '汪女士' : '家人小张'),
        updatedAt: Date.now(),
      };
      patients[index] = updated;
      return updated;
    },
    getPatientGroups: (id: string) =>
      id === 'pat_1'
        ? {
            patient: { id: 'pat_1', displayName: '汪女士' },
            groups: [
              {
                id: 'grp_1',
                name: '客户-汪女士',
                roomId: 'room_1',
                status: 'serving',
                isPrimary: true,
              },
            ],
          }
        : undefined,
  });

  ctx.provide('zhibanWecomAdmin', {
    listDrafts: () => drafts,
    getDraftDetail: (id: string) => drafts.find((draft) => draft.id === id),
    listGroups: () => [
      {
        roomId: 'room_1',
        name: '客户-汪女士',
        advisorId: 'adv_1',
      },
    ],
    listAudits: () => [
      {
        id: 'aud_1',
        at: Date.now() - 2 * 60_000,
        actor: 'system',
        action: 'draft.verified',
        target: 'draft_1',
        result: 'success',
      },
    ],
    async getDraftEvidence(draftId: string) {
      return draftId === 'draft_1'
        ? {
            sent: {
              msgid: 'm_sent_1',
              text: '晚餐清淡一点，避开海鲜。',
              msgtime: Date.now() - 2 * 60_000,
            },
          }
        : undefined;
    },
    pauseAdvisor(advisorId: string) {
      paused.push(advisorId);
      return { id: advisorId, name: advisor.name, status: 'paused', consecutiveMisroutes: 0 };
    },
    restoreAdvisor() {
      return { id: advisor.id, name: advisor.name, status: 'active', consecutiveMisroutes: 0 };
    },
    async releaseQueue() {
      return { releasedDraftId: 'draft_4', nextDraftId: null };
    },
  });

  ctx.provide('zhibanMemory', {
    available: () => true,
    render: () => [],
    list: (patientId: string) => memories.filter((memory) => memory.patientId === patientId),
    get: (id: string) => memories.find((memory) => memory.id === id),
    count: (patientId: string) =>
      memories.filter((memory) => memory.patientId === patientId && memory.deletedAt === undefined)
        .length,
  });

  return { patients, advisor, drafts, paused, memories };
}

/** 用真实 KnowledgeService + 内存后端，验证控制台路由而不是另写一份知识逻辑。 */
function installKnowledgeApi(ctx: FakeConsoleContext): { records: Map<string, KnowledgeRecord> } {
  const records = new Map<string, KnowledgeRecord>();
  let seq = 0;
  const service = new KnowledgeService({
    tenantId: 'tn_test',
    backend: {
      load: () => [...records.values()],
      put: async (record) => {
        records.set(record.id, record);
      },
    },
    newId: () => `knw_${++seq}`,
  });
  ctx.provide('zhibanKnowledge', {
    list: (query?: KnowledgeQuery) => service.list(query),
    get: (id: string) => service.get(id),
    create: (input: KnowledgeCreateInput) => service.create(input, 'test'),
    update: (id: string, patch: KnowledgeUpdateInput) => service.update(id, patch, 'test'),
    remove: (id: string) => service.remove(id, 'test'),
    categories: () => service.categories(),
  });
  return { records };
}

/** 用真实 GuardService + 内存后端，验证控制台路由与内置红线只读语义。 */
function installGuardApi(ctx: FakeConsoleContext): {
  rules: Map<string, RiskRuleRecord>;
} {
  const rules = new Map<string, RiskRuleRecord>();
  const alerts: GuardAlertRecord[] = [];
  let seq = 0;
  const service = new GuardService({
    tenantId: 'tn_test',
    backend: {
      loadRules: () => [...rules.values()],
      loadAlerts: () => alerts,
      putRule: async (rule) => {
        rules.set(rule.id, rule);
      },
      deleteRule: async (id) => {
        rules.delete(id);
      },
      putAlert: async (alert) => {
        alerts.push(alert);
      },
    },
    newId: () => `rul_kw_${++seq}`,
  });
  ctx.provide('zhibanGuard', {
    listRules: (query?: { kind?: 'redline' | 'keyword'; enabled?: boolean }) =>
      service.list(query),
    getRule: (id: string) => service.get(id),
    createRule: (input: RiskRuleCreateInput) => service.create(input),
    updateRule: (id: string, patch: RiskRuleUpdateInput) => service.update(id, patch),
    deleteRule: (id: string) => service.remove(id),
  });
  return { rules };
}

test('知识库：真实 CRUD、分页、重复标题与控制台审计', async () => {
  const { ctx, call } = await start();
  installKnowledgeApi(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const empty = await call('GET', '/zhiban/api/knowledge', { cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json(), { items: [], page: 1, pageSize: 50, total: 0 });

  const created = await call('POST', '/zhiban/api/knowledge', {
    cookie,
    body: {
      category: '饮食建议',
      title: '晚餐建议在 19 点前完成',
      content: '晚餐尽量在 19 点前吃完，避免夜间加餐。',
    },
  });
  assert.equal(created.status, 201);
  const first = created.json() as unknown as KnowledgeRecord;
  assert.equal(first.id, 'knw_1');
  assert.equal(first.enabled, true);
  assert.equal(first.hits, 0);
  assert.equal(first.deletedAt, null);
  assert.equal(first.category, '饮食建议');

  const duplicate = await call('POST', '/zhiban/api/knowledge', {
    cookie,
    body: { category: '饮食建议', title: '晚餐建议在 19 点前完成', content: '另一段内容' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.json() as { error: { code: string } }).error.code, 'CONFLICT');

  // 跨分类允许同名
  const otherCategory = await call('POST', '/zhiban/api/knowledge', {
    cookie,
    body: { category: '作息管理', title: '晚餐建议在 19 点前完成', content: '早睡早起。' },
  });
  assert.equal(otherCategory.status, 201);

  const missingTitle = await call('POST', '/zhiban/api/knowledge', {
    cookie,
    body: { category: '饮食建议', title: '   ', content: '正文' },
  });
  assert.equal(missingTitle.status, 422);
  assert.equal((missingTitle.json() as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

  const longTitle = await call('POST', '/zhiban/api/knowledge', {
    cookie,
    body: { category: '饮食建议', title: '超'.repeat(61), content: '正文' },
  });
  assert.equal(longTitle.status, 422);

  const badEnabled = await call('POST', '/zhiban/api/knowledge', {
    cookie,
    body: { category: '饮食建议', title: '开关', content: '正文', enabled: 'yes' },
  });
  assert.equal(badEnabled.status, 422);

  const filtered = await call('GET', '/zhiban/api/knowledge?category=%E9%A5%AE%E9%A3%9F%E5%BB%BA%E8%AE%AE', {
    cookie,
  });
  assert.equal(filtered.status, 200);
  const filteredBody = filtered.json() as { items: KnowledgeRecord[]; total: number };
  assert.equal(filteredBody.total, 1);
  assert.equal(filteredBody.items[0]!.id, 'knw_1');

  const badFilter = await call('GET', '/zhiban/api/knowledge?enabled=maybe', { cookie });
  assert.equal(badFilter.status, 422);

  const categories = await call('GET', '/zhiban/api/knowledge/categories', { cookie });
  assert.equal(categories.status, 200);
  assert.deepEqual((categories.json() as { items: Array<{ category: string; count: number }> }).items, [
    { category: '饮食建议', count: 1 },
    { category: '作息管理', count: 1 },
  ]);

  const disabled = await call('PATCH', `/zhiban/api/knowledge/${first.id}`, {
    cookie,
    body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal((disabled.json() as unknown as KnowledgeRecord).enabled, false);

  const renamed = await call('PATCH', `/zhiban/api/knowledge/knw_2`, {
    cookie,
    body: { title: '晚餐建议在 19 点前完成' },
  });
  assert.equal(renamed.status, 200);

  const updateConflict = await call('PATCH', `/zhiban/api/knowledge/knw_2`, {
    cookie,
    body: { category: '饮食建议', title: '晚餐建议在 19 点前完成' },
  });
  assert.equal(updateConflict.status, 409);

  const missing = await call('PATCH', '/zhiban/api/knowledge/knw_404', {
    cookie,
    body: { title: '不存在' },
  });
  assert.equal(missing.status, 404);

  const removed = await call('DELETE', `/zhiban/api/knowledge/${first.id}`, { cookie });
  assert.equal(removed.status, 204);

  const afterDelete = await call('GET', '/zhiban/api/knowledge', { cookie });
  assert.equal((afterDelete.json() as { total: number }).total, 1);

  const removeAgain = await call('DELETE', `/zhiban/api/knowledge/${first.id}`, { cookie });
  assert.equal(removeAgain.status, 204);

  const audit = await call('GET', '/zhiban/api/audit?targetType=knowledge', { cookie });
  assert.equal(audit.status, 200);
  const events = (audit.json() as { items: Array<{ action: string; targetId: string; detail?: Record<string, unknown> }> }).items;
  assert.deepEqual(
    events.map((event) => event.action).sort(),
    [
      'knowledge.created',
      'knowledge.created',
      'knowledge.deleted',
      'knowledge.updated',
      'knowledge.updated',
    ],
  );
  assert.equal(JSON.stringify(events).includes('夜间加餐'), false);
  assert.equal(JSON.stringify(events).includes('晚餐建议在 19 点前完成'), true);
});

test('知识库：读对全部角色开放，写仅 admin，platform 一律 404', async () => {
  const { ctx, call } = await start();
  installKnowledgeApi(ctx);
  const admin = await login(call, 'admin', ADMIN_PASSWORD);

  for (const [username, role] of [
    ['supervisor.kb', 'supervisor'],
    ['viewer.kb', 'viewer'],
  ] as const) {
    const created = await call('POST', '/zhiban/api/accounts', {
      cookie: admin.cookie,
      body: { username, displayName: username, role, password: 'StaffPass123' },
    });
    assert.equal(created.status, 201);
  }

  for (const [username, role] of [
    ['supervisor.kb', 'supervisor'],
    ['viewer.kb', 'viewer'],
  ] as const) {
    const { cookie } = await login(call, username, 'StaffPass123');
    const readable = await call('GET', '/zhiban/api/knowledge', { cookie });
    assert.equal(readable.status, 200, `${role} 应可读`);
    const write = await call('POST', '/zhiban/api/knowledge', {
      cookie,
      body: { category: '通用', title: `${role} 写入`, content: '正文' },
    });
    assert.equal(write.status, 403, `${role} 不应可写`);
    assert.equal((write.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  }

  const platform = await login(call, 'platform', PLATFORM_PASSWORD);
  const platformRead = await call('GET', '/zhiban/api/knowledge', { cookie: platform.cookie });
  assert.equal(platformRead.status, 404);

  // 写入后分页信息完整
  for (let i = 0; i < 3; i += 1) {
    const created = await call('POST', '/zhiban/api/knowledge', {
      cookie: admin.cookie,
      body: { category: '通用', title: `条目 ${i}`, content: '正文' },
    });
    assert.equal(created.status, 201);
  }
  const page = await call('GET', '/zhiban/api/knowledge?page=2&pageSize=2', { cookie: admin.cookie });
  assert.equal(page.status, 200);
  const pageBody = page.json() as { items: KnowledgeRecord[]; page: number; pageSize: number; total: number };
  assert.deepEqual(pageBody.items.map((item) => item.title), ['条目 2']);
  assert.equal(pageBody.page, 2);
  assert.equal(pageBody.pageSize, 2);
  assert.equal(pageBody.total, 3);
  const capped = await call('GET', '/zhiban/api/knowledge?pageSize=999', { cookie: admin.cookie });
  assert.equal((capped.json() as { pageSize: number }).pageSize, 200);
});

test('知识库：插件未就绪时返回 502 而不是 500', async () => {
  const { call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);
  const res = await call('GET', '/zhiban/api/knowledge', { cookie });
  assert.equal(res.status, 502);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'UPSTREAM_UNAVAILABLE');
});


test('工作台：价值与 KPI 直接来自真实草稿，不出现示例数据', async () => {
  const { ctx, call } = await start();
  installRealDataPorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const value = await call('GET', '/zhiban/api/dashboard/value?range=week', { cookie });
  assert.equal(value.status, 200);
  const valueBody = value.json() as {
    adoption: { original: number; revised: number; edited: number; sentTotal: number; rate: number };
    savedMinutes: number;
    minutesPerDraft: number;
    patientsPerAdvisor: number;
    verificationPassRate: number;
    trend: Array<{ date: string; label: string; volume: number; verified: number }>;
    advisorRanking: Array<{ advisorId: string; name: string; volume: number; verified: number }>;
  };
  assert.equal(valueBody.adoption.sentTotal, 2);
  assert.equal(valueBody.adoption.original, 1);
  assert.equal(valueBody.adoption.revised, 1);
  assert.equal(valueBody.adoption.edited, 0);
  assert.equal(valueBody.adoption.rate, 1);
  assert.equal(valueBody.savedMinutes, 6);
  assert.equal(valueBody.minutesPerDraft, 3);
  assert.equal(valueBody.patientsPerAdvisor, 2);
  assert.equal(valueBody.verificationPassRate, 1);

  // 趋势与排行同样是真实草稿，而不是示例数据（示例总数为 420）
  assert.equal(valueBody.trend.length, 14);
  assert.equal(
    valueBody.trend.reduce((sum, point) => sum + point.volume, 0),
    4,
  );
  const todayPoint = valueBody.trend[valueBody.trend.length - 1]!;
  assert.equal(todayPoint.volume, 4);
  assert.equal(todayPoint.verified, 2);
  assert.deepEqual(
    valueBody.advisorRanking.map((row) => row.advisorId),
    ['adv_1'],
  );
  assert.equal(valueBody.advisorRanking[0]!.volume, 4);
  assert.equal(valueBody.advisorRanking[0]!.verified, 2);

  const kpis = await call('GET', '/zhiban/api/dashboard/kpis?range=week', { cookie });
  assert.equal(kpis.status, 200);
  const kpiBody = kpis.json() as {
    onlineAgents: number;
    draftsToday: number;
    verificationPassRate: number;
    avgResponseSeconds: number;
    openAlerts: number;
  };
  assert.equal(kpiBody.onlineAgents, 1);
  assert.equal(kpiBody.draftsToday, 4);
  assert.equal(kpiBody.verificationPassRate, 1);
  assert.ok(kpiBody.avgResponseSeconds > 0);
  assert.equal(kpiBody.openAlerts, 0);

  const recent = await call('GET', '/zhiban/api/dashboard/recent?limit=2', { cookie });
  assert.equal(recent.status, 200);
  const recentBody = recent.json() as {
    items: Array<{
      id: string;
      patientName: string;
      advisorName: string;
      groupName: string;
      preview: string;
      outcome: string;
      at: number;
      sandbox: boolean;
    }>;
  };
  assert.equal(recentBody.items.length, 2);
  assert.equal(recentBody.items[0]!.id, 'draft_1');
  assert.equal(recentBody.items[0]!.outcome, 'verified');
  assert.equal(recentBody.items[0]!.patientName, '汪女士');
  assert.equal(recentBody.items[0]!.advisorName, '李广');
  assert.equal(recentBody.items[0]!.sandbox, false);
  assert.ok(recentBody.items.every((item) => typeof item.at === 'number'));

  const recentAll = await call('GET', '/zhiban/api/dashboard/recent?limit=10', { cookie });
  const skipped = (recentAll.json() as { items: Array<{ id: string; outcome: string }> }).items.find(
    (item) => item.id === 'draft_3',
  );
  assert.equal(skipped?.outcome, 'pending');

  const invalid = await call('GET', '/zhiban/api/dashboard/value?range=year', { cookie });
  assert.equal(invalid.status, 422);
});

test('患者：真实患者列表区分 demo，详情含群与顾问，健康档案返回空而非假数据', async () => {
  const { ctx, call } = await start();
  installRealDataPorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const all = await call('GET', '/zhiban/api/patients', { cookie });
  assert.equal(all.status, 200);
  const allBody = all.json() as { items: Array<Record<string, unknown>>; total: number };
  assert.equal(allBody.total, 2);
  assert.equal(allBody.items.some((item) => item.demo === true), true);
  assert.equal(allBody.items.some((item) => item.demo === false), true);

  const real = await call('GET', '/zhiban/api/patients?demo=false', { cookie });
  assert.equal((real.json() as { total: number }).total, 1);

  const detail = await call('GET', '/zhiban/api/patients/pat_1', { cookie });
  assert.equal(detail.status, 200);
  const detailBody = detail.json() as {
    patient: { displayName: string; advisorId: string; memoryCount: number };
    advisor: { id: string; name: string; online: boolean };
    groups: Array<{ id: string; isPrimary: boolean }>;
  };
  assert.equal(detailBody.patient.displayName, '汪女士');
  assert.equal(detailBody.patient.advisorId, 'adv_1');
  assert.equal(detailBody.patient.memoryCount, 1);
  assert.equal(detailBody.advisor.name, '李广');
  assert.equal(detailBody.advisor.online, true);
  assert.equal(detailBody.groups[0]!.isPrimary, true);

  const patched = await call('PATCH', '/zhiban/api/patients/pat_1', {
    cookie,
    body: { displayName: '汪女士（VIP）', tags: ['高血压'] },
  });
  assert.equal(patched.status, 200);
  assert.equal((patched.json() as { displayName: string }).displayName, '汪女士（VIP）');

  const invalid = await call('PATCH', '/zhiban/api/patients/pat_1', {
    cookie,
    body: { consent: 'unknown-ish' },
  });
  assert.equal(invalid.status, 422);

  const profile = await call('GET', '/zhiban/api/patients/pat_1/health-profile', { cookie });
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.json(), { profile: null, sample: true });

  const plan = await call('GET', '/zhiban/api/patients/pat_1/service-plan', { cookie });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json(), { plan: null, sample: true });

  const missing = await call('GET', '/zhiban/api/patients/pat_404', { cookie });
  assert.equal(missing.status, 404);
});

test('患者身份：群成员列表可读，改绑患者写权限与校验生效', async () => {
  const { ctx, call } = await start();
  installRealDataPorts(ctx);
  const admin = await login(call, 'admin', ADMIN_PASSWORD);
  const cookie = admin.cookie;

  // 群成员列表：外部成员（含角色/同意）+ 内部员工
  const members = await call('GET', '/zhiban/api/groups/grp_1/members', { cookie });
  assert.equal(members.status, 200);
  const memberBody = members.json() as unknown as {
    items: Array<Record<string, unknown>>;
    total: number;
  };
  assert.equal(memberBody.total, 3);
  assert.equal(memberBody.items[0]!.displayName, '汪女士');
  assert.equal(memberBody.items[0]!.role, 'self');
  assert.equal(memberBody.items[0]!.consent, 'agreed');
  assert.equal(memberBody.items[2]!.isExternal, false);

  const notFound = await call('GET', '/zhiban/api/groups/grp_404/members', { cookie });
  assert.equal(notFound.status, 404);

  // 改绑患者：指向群内另一位外部成员，返回已确认的 patientView
  const rebind = await call('POST', '/zhiban/api/patients/pat_1/identity', {
    cookie,
    body: { groupId: 'grp_1', externalUserId: 'wm_family_1' },
  });
  assert.equal(rebind.status, 200);
  const rebindBody = rebind.json() as {
    externalUserId: string;
    identityStatus: string;
    identitySource: string;
    displayName: string;
  };
  assert.equal(rebindBody.externalUserId, 'wm_family_1');
  assert.equal(rebindBody.identityStatus, 'confirmed');
  assert.equal(rebindBody.identitySource, 'manual');
  assert.equal(rebindBody.displayName, '家人小张');

  // 校验失败：未绑定该群 / 内部员工目标 / 缺参
  const notBound = await call('POST', '/zhiban/api/patients/pat_1/identity', {
    cookie,
    body: { groupId: 'grp_other', externalUserId: 'wm_family_1' },
  });
  assert.equal(notBound.status, 422);
  const internal = await call('POST', '/zhiban/api/patients/pat_1/identity', {
    cookie,
    body: { groupId: 'grp_1', externalUserId: 'LiGuang' },
  });
  assert.equal(internal.status, 422);
  const missingArg = await call('POST', '/zhiban/api/patients/pat_1/identity', {
    cookie,
    body: { groupId: 'grp_1' },
  });
  assert.equal(missingArg.status, 422);

  // 只读账号：读成员列表 OK，改绑被拒
  await call('POST', '/zhiban/api/accounts', {
    cookie,
    body: {
      username: 'viewer.identity',
      displayName: '只读二号',
      role: 'viewer',
      password: 'ViewerPass123',
    },
  });
  const viewer = await login(call, 'viewer.identity', 'ViewerPass123');
  const canRead = await call('GET', '/zhiban/api/groups/grp_1/members', {
    cookie: viewer.cookie,
  });
  assert.equal(canRead.status, 200);
  const forbidden = await call('POST', '/zhiban/api/patients/pat_1/identity', {
    cookie: viewer.cookie,
    body: { groupId: 'grp_1', externalUserId: 'wm_family_1' },
  });
  assert.equal(forbidden.status, 403);
});

test('服务流：行来自真实草稿，详情只从存档证据生成送达记录', async () => {
  const { ctx, call } = await start();
  installRealDataPorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const list = await call('GET', '/zhiban/api/service-flow?status=VERIFIED', { cookie });
  assert.equal(list.status, 200);
  const listBody = list.json() as {
    items: Array<{
      id: string;
      patientId: string;
      advisorId: string;
      groupId: string;
      status: string;
      demo: boolean;
      mediaKinds: string[];
    }>;
    total: number;
  };
  assert.equal(listBody.total, 2);
  const row = listBody.items.find((item) => item.id === 'draft_1');
  assert.ok(row);
  assert.equal(row.patientId, 'pat_1');
  assert.equal(row.advisorId, 'adv_1');
  assert.equal(row.groupId, 'grp_1');
  assert.equal(row.demo, false);
  assert.deepEqual(row.mediaKinds, ['meal']);

  const sorted = await call('GET', '/zhiban/api/service-flow', { cookie });
  const ids = (sorted.json() as { items: Array<{ id: string }> }).items.map((item) => item.id);
  assert.equal(ids[0], 'draft_1'); // createdAt 最新
  assert.equal(ids.length, 4);

  const detail = await call('GET', '/zhiban/api/service-flow/draft_1', { cookie });
  assert.equal(detail.status, 200);
  const detailBody = detail.json() as {
    draft: { id: string; status: string; demo: boolean };
    patient: { id: string; displayName: string };
    group: { id: string; roomId: string };
    advisor: { id: string; name: string };
    citations: {
      memories: Array<{ id: string; content: string }>;
      knowledge: Array<{ id: string; title: string }>;
    };
    deliveries: Array<{ msgid: string; text: string; source: string }>;
    verification: { outcome: string; matchedMsgId: string } | null;
    audit: Array<{ action: string; target?: string }>;
    media: Array<{ id: string; kind: string; url: string }>;
  };
  assert.equal(detailBody.patient.id, 'pat_1');
  assert.equal(detailBody.group.id, 'grp_1');
  assert.equal(detailBody.group.roomId, 'room_1');
  assert.equal(detailBody.advisor.name, '李广');
  assert.deepEqual(detailBody.citations.memories.map((item) => item.id), ['mem_1']);
  assert.equal(detailBody.citations.memories[0]!.content, '晚餐不吃海鲜');
  assert.equal(detailBody.citations.knowledge.length, 0); // 未接知识库时不伪造
  assert.equal(detailBody.deliveries.length, 1);
  assert.equal(detailBody.deliveries[0]!.msgid, 'm_sent_1');
  assert.equal(detailBody.verification?.outcome, 'verified');
  assert.equal(detailBody.audit[0]!.action, 'draft.verified');
  assert.equal(detailBody.media.length, 1);
  assert.match(detailBody.media[0]!.id, /^arc_/);
  assert.equal(detailBody.media[0]!.url, `/zhiban/api/media/${detailBody.media[0]!.id}`);
  assert.equal(JSON.stringify(detailBody).includes('/var/lib/zhiban'), false);

  const missing = await call('GET', '/zhiban/api/service-flow/draft_404', { cookie });
  assert.equal(missing.status, 404);
});

test('顾问：队列深度来自真实草稿，暂停/恢复同时落到企微与患者域', async () => {
  const { ctx, call } = await start();
  const ports = installRealDataPorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  // 员工发言命中红线：告警带 advisorId，顾问列表能看到个人留痕
  ctx.emitTo('alert.created', {
    id: 'alt_staff_test_1',
    kind: 'redline',
    severity: 'warning',
    status: 'open',
    title: '员工发言命中红线',
    message: '群「服务群」的员工发言命中规则：不调药',
    advisorId: 'adv_1',
    groupId: 'grp_1',
    createdAt: Date.now(),
  });
  const redlineAlerts = await call('GET', '/zhiban/api/alerts?kind=redline&advisorId=adv_1', {
    cookie,
  });
  assert.equal(redlineAlerts.status, 200);
  assert.equal((redlineAlerts.json() as { total: number }).total, 1);

  const list = await call('GET', '/zhiban/api/advisors', { cookie });
  assert.equal(list.status, 200);
  const body = list.json() as {
    items: Array<{
      id: string;
      name: string;
      status: string;
      queueDepth: number;
      online: boolean;
      redlineHits: number;
      redlineOpen: number;
      redlineLastAt: number | null;
    }>;
    total: number;
  };
  assert.equal(body.total, 1);
  assert.equal(body.items[0]!.queueDepth, 1);
  assert.equal(body.items[0]!.online, true);
  assert.equal(body.items[0]!.redlineHits, 1);
  assert.equal(body.items[0]!.redlineOpen, 1);
  assert.equal(typeof body.items[0]!.redlineLastAt, 'number');

  const paused = await call('POST', '/zhiban/api/advisors/adv_1/pause', {
    cookie,
    body: { reason: '手工暂停' },
  });
  assert.equal(paused.status, 200);
  assert.equal((paused.json() as { status: string }).status, 'paused');
  assert.deepEqual(ports.paused, ['adv_1']);

  const resumed = await call('POST', '/zhiban/api/advisors/adv_1/resume', { cookie });
  assert.equal(resumed.status, 200);
  assert.equal((resumed.json() as { status: string }).status, 'active');

  const released = await call('POST', '/zhiban/api/advisors/adv_1/queue/release', { cookie });
  assert.equal(released.status, 200);
  assert.equal((released.json() as { releasedDraftId: string }).releasedDraftId, 'draft_4');

  const missing = await call('POST', '/zhiban/api/advisors/adv_404/pause', { cookie });
  assert.equal(missing.status, 404);
});


test('群绑定：绑定已有患者或新建患者，未知群 404，写权限生效', async () => {
  const { ctx, call } = await start();
  const ports = installRealDataPorts(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const bindExisting = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { patientId: 'pat_2' },
  });
  assert.equal(bindExisting.status, 201);
  const existingBody = bindExisting.json() as {
    binding: { groupId: string; patientId: string; isPrimary: boolean; deletedAt: null };
    patient: { id: string; displayName: string };
  };
  assert.equal(existingBody.binding.groupId, 'grp_1');
  assert.equal(existingBody.binding.patientId, 'pat_2');
  assert.equal(existingBody.binding.deletedAt, null);
  assert.equal(existingBody.patient.displayName, '示例患者');

  const created = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { newPatient: { displayName: '新客户', tags: ['糖尿病'] } },
  });
  assert.equal(created.status, 201);
  const createdBody = created.json() as {
    binding: { patientId: string };
    patient: { id: string; displayName: string; tags: string[] };
  };
  assert.equal(createdBody.patient.displayName, '新客户');
  assert.deepEqual(createdBody.patient.tags, ['糖尿病']);
  assert.equal(ports.patients.length, 3);

  const missingGroup = await call('POST', '/zhiban/api/groups/grp_404/bindings', {
    cookie,
    body: { patientId: 'pat_2' },
  });
  assert.equal(missingGroup.status, 404);

  const empty = await call('POST', '/zhiban/api/groups/grp_1/bindings', { cookie, body: {} });
  assert.equal(empty.status, 422);

  // 从群成员选服务对象：外部成员没有患者时新建，并回填身份
  const beforeMembers = ports.patients.length;
  const byMember = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { memberId: 'gm_2' },
  });
  assert.equal(byMember.status, 201);
  const memberBody = byMember.json() as {
    binding: { patientId: string };
    patient: {
      id: string;
      displayName: string;
      externalUserId: string | null;
      advisorId: string | null;
      identityStatus: string;
    };
  };
  assert.equal(memberBody.patient.displayName, '家人小张');
  assert.equal(memberBody.patient.externalUserId, 'wm_family_1');
  assert.equal(memberBody.patient.advisorId, 'adv_1');
  assert.equal(memberBody.patient.identityStatus, 'confirmed');
  assert.equal(ports.patients.length, beforeMembers + 1);

  // 同一 externalUserId 再次选择时复用患者，不再重复建 Agent
  const reused = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { memberId: 'gm_2' },
  });
  assert.equal(reused.status, 201);
  assert.equal(
    (reused.json() as { patient: { id: string } }).patient.id,
    memberBody.patient.id,
  );
  assert.equal(ports.patients.length, beforeMembers + 1);

  // 已在其他群有患者的客户（wm_test_1 → pat_1）直接复用
  const existingCustomer = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { memberId: 'gm_1' },
  });
  assert.equal(existingCustomer.status, 201);
  assert.equal(
    (existingCustomer.json() as { patient: { id: string } }).patient.id,
    'pat_1',
  );
  assert.equal(ports.patients.length, beforeMembers + 1);

  // 员工成员不能作为服务对象，未知成员 422
  const staff = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { memberId: 'gm_3' },
  });
  assert.equal(staff.status, 422);
  assert.equal((staff.json() as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

  const unknownMember = await call('POST', '/zhiban/api/groups/grp_1/bindings', {
    cookie,
    body: { memberId: 'gm_404' },
  });
  assert.equal(unknownMember.status, 422);

  const createdPatient = await call('POST', '/zhiban/api/patients', {
    cookie,
    body: { displayName: '独立患者', consent: 'agreed' },
  });
  assert.equal(createdPatient.status, 201);
  const patientBody = createdPatient.json() as { id: string; displayName: string; demo: boolean };
  assert.equal(patientBody.displayName, '独立患者');
  assert.equal(patientBody.demo, false);
});

test('风险规则：内置红线只读，关键词规则 CRUD 与审计', async () => {
  const { ctx, call } = await start();
  installGuardApi(ctx);
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const list = await call('GET', '/zhiban/api/risk-rules', { cookie });
  assert.equal(list.status, 200);
  const listBody = list.json() as { items: RiskRuleRecord[]; total: number };
  assert.equal(listBody.total, 4);
  assert.ok(listBody.items.every((rule) => rule.kind === 'redline' && rule.builtin));
  const builtin = listBody.items[0]!;

  const keywordOnly = await call('GET', '/zhiban/api/risk-rules?kind=keyword', { cookie });
  assert.equal((keywordOnly.json() as { total: number }).total, 0);
  const badKind = await call('GET', '/zhiban/api/risk-rules?kind=other', { cookie });
  assert.equal(badKind.status, 422);
  const badEnabled = await call('GET', '/zhiban/api/risk-rules?enabled=maybe', { cookie });
  assert.equal(badEnabled.status, 422);

  const created = await call('POST', '/zhiban/api/risk-rules', {
    cookie,
    body: {
      kind: 'keyword',
      name: '自定义规则',
      keywords: ['胸闷复查词', ' 胸闷复查词 ', '复查提醒'],
      riskLevel: 'medium',
    },
  });
  assert.equal(created.status, 201);
  const rule = created.json() as unknown as RiskRuleRecord;
  assert.equal(rule.kind, 'keyword');
  assert.equal(rule.builtin, false);
  assert.equal(rule.action, 'flag');
  assert.equal(rule.enabled, true);
  assert.deepEqual(rule.keywords, ['胸闷复查词', '复查提醒']);

  const redline = await call('POST', '/zhiban/api/risk-rules', {
    cookie,
    body: {
      kind: 'redline',
      name: '自建红线',
      keywords: ['诊断'],
      riskLevel: 'high',
      action: 'flag',
    },
  });
  assert.equal(redline.status, 422);
  assert.equal((redline.json() as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ name: '', keywords: ['甲'], riskLevel: 'high' }, '空名称'],
    [{ name: '超'.repeat(41), keywords: ['甲'], riskLevel: 'high' }, '名称超长'],
    [{ name: '规则', keywords: [], riskLevel: 'high' }, '空关键词'],
    [{ name: '规则', keywords: Array.from({ length: 21 }, (_, i) => `词${i}`), riskLevel: 'high' }, '关键词过多'],
    [{ name: '规则', keywords: ['超'.repeat(31)], riskLevel: 'high' }, '关键词超长'],
    [{ name: '规则', keywords: ['甲'], riskLevel: 'urgent' }, '等级非法'],
    [{ name: '规则', keywords: ['甲'], riskLevel: 'high', action: 'ignore' }, '动作非法'],
    [{ name: '规则', keywords: ['甲'], riskLevel: 'high', enabled: 'yes' }, '启用非布尔'],
  ];
  for (const [body, label] of invalid) {
    const res = await call('POST', '/zhiban/api/risk-rules', { cookie, body });
    assert.equal(res.status, 422, label);
  }

  const updated = await call('PATCH', `/zhiban/api/risk-rules/${rule.id}`, {
    cookie,
    body: { name: '改名规则', keywords: ['复查提醒'], enabled: false },
  });
  assert.equal(updated.status, 200);
  const updatedRule = updated.json() as unknown as RiskRuleRecord;
  assert.equal(updatedRule.name, '改名规则');
  assert.equal(updatedRule.enabled, false);

  const filtered = await call('GET', '/zhiban/api/risk-rules?kind=keyword&enabled=false', { cookie });
  assert.equal((filtered.json() as { total: number }).total, 1);

  const patchBuiltin = await call('PATCH', `/zhiban/api/risk-rules/${builtin.id}`, {
    cookie,
    body: { name: '改红线' },
  });
  assert.equal(patchBuiltin.status, 409);
  assert.equal((patchBuiltin.json() as { error: { code: string } }).error.code, 'BUILTIN_RULE');

  const patchMissing = await call('PATCH', '/zhiban/api/risk-rules/rul_404', {
    cookie,
    body: { name: '不存在' },
  });
  assert.equal(patchMissing.status, 404);

  const deleteBuiltin = await call('DELETE', `/zhiban/api/risk-rules/${builtin.id}`, { cookie });
  assert.equal(deleteBuiltin.status, 409);
  assert.equal((deleteBuiltin.json() as { error: { code: string } }).error.code, 'BUILTIN_RULE');

  const removed = await call('DELETE', `/zhiban/api/risk-rules/${rule.id}`, { cookie });
  assert.equal(removed.status, 204);
  const afterDelete = await call('GET', '/zhiban/api/risk-rules', { cookie });
  assert.equal((afterDelete.json() as { total: number }).total, 4);

  const deleteMissing = await call('DELETE', '/zhiban/api/risk-rules/rul_404', { cookie });
  assert.equal(deleteMissing.status, 404);

  const audit = await call('GET', '/zhiban/api/audit?targetType=risk_rule', { cookie });
  assert.equal(audit.status, 200);
  const events = (audit.json() as {
    items: Array<{
      action: string;
      targetId: string;
      detail?: Record<string, unknown>;
    }>;
  }).items;
  assert.deepEqual(
    events.map((event) => event.action).sort(),
    ['rule.created', 'rule.deleted', 'rule.updated'],
  );
  const updatedEvent = events.find((event) => event.action === 'rule.updated');
  assert.equal(updatedEvent?.targetId, rule.id);
  assert.deepEqual(updatedEvent?.detail?.changes, {
    name: { from: '自定义规则', to: '改名规则' },
    enabled: { from: true, to: false },
  });
  assert.equal(JSON.stringify(events).includes('胸闷复查词'), false);
});

test('风险规则：读对全部角色开放，写仅 admin，platform 一律 404', async () => {
  const { ctx, call } = await start();
  installGuardApi(ctx);
  const admin = await login(call, 'admin', ADMIN_PASSWORD);

  for (const [username, role] of [
    ['supervisor.rule', 'supervisor'],
    ['viewer.rule', 'viewer'],
  ] as const) {
    const created = await call('POST', '/zhiban/api/accounts', {
      cookie: admin.cookie,
      body: { username, displayName: username, role, password: 'StaffPass123' },
    });
    assert.equal(created.status, 201);
  }

  for (const [username, role] of [
    ['supervisor.rule', 'supervisor'],
    ['viewer.rule', 'viewer'],
  ] as const) {
    const { cookie } = await login(call, username, 'StaffPass123');
    const readable = await call('GET', '/zhiban/api/risk-rules', { cookie });
    assert.equal(readable.status, 200, `${role} 应可读`);
    const write = await call('POST', '/zhiban/api/risk-rules', {
      cookie,
      body: { name: `${role} 写入`, keywords: ['甲'], riskLevel: 'low' },
    });
    assert.equal(write.status, 403, `${role} 不应可写`);
    assert.equal((write.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  }

  const platform = await login(call, 'platform', PLATFORM_PASSWORD);
  const platformRead = await call('GET', '/zhiban/api/risk-rules', { cookie: platform.cookie });
  assert.equal(platformRead.status, 404);
});

test('风险规则：插件未就绪时返回 502 而不是 500', async () => {
  const { call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);
  const res = await call('GET', '/zhiban/api/risk-rules', { cookie });
  assert.equal(res.status, 502);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'UPSTREAM_UNAVAILABLE');
});

test('话术库：真实 CRUD、校验、软删除与控制台审计', async () => {
  const { call } = await start();
  const { cookie } = await login(call, 'admin', ADMIN_PASSWORD);

  const empty = await call('GET', '/zhiban/api/scripts', { cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json(), { items: [], total: 0, sample: false });

  const created = await call('POST', '/zhiban/api/scripts', {
    cookie,
    body: {
      category: ' 饮食 ',
      title: '晚餐建议',
      content: '建议晚餐在 19 点前完成。',
      tags: ['复诊', ' 饮食 ', '复诊'],
      enabled: false,
    },
  });
  assert.equal(created.status, 201);
  const script = created.json() as {
    id: string;
    category: string;
    title: string;
    tags: string[];
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
  };
  assert.match(script.id, /^scr_/);
  assert.equal(script.category, '饮食');
  assert.equal(script.title, '晚餐建议');
  assert.deepEqual(script.tags, ['复诊', '饮食']);
  assert.equal(script.enabled, false);

  const second = await call('POST', '/zhiban/api/scripts', {
    cookie,
    body: { category: '作息', title: '晚睡回应', content: '先确认最近入睡时间。' },
  });
  assert.equal(second.status, 201);
  assert.equal((second.json() as { enabled: boolean }).enabled, true);

  const all = await call('GET', '/zhiban/api/scripts', { cookie });
  assert.deepEqual(
    (all.json() as { items: Array<{ title: string }> }).items.map((item) => item.title),
    ['晚餐建议', '晚睡回应'],
  );
  const disabled = await call('GET', '/zhiban/api/scripts?enabled=false', { cookie });
  assert.equal((disabled.json() as { total: number }).total, 1);
  const byCategory = await call('GET', '/zhiban/api/scripts?category=饮食', { cookie });
  assert.equal((byCategory.json() as { total: number }).total, 1);
  const bySearch = await call('GET', `/zhiban/api/scripts?q=${encodeURIComponent('复诊')}`, {
    cookie,
  });
  assert.equal((bySearch.json() as { total: number }).total, 1);
  const badEnabled = await call('GET', '/zhiban/api/scripts?enabled=maybe', { cookie });
  assert.equal(badEnabled.status, 422);

  const updated = await call('PATCH', `/zhiban/api/scripts/${script.id}`, {
    cookie,
    body: { title: '晚餐与复诊', tags: ['复诊'], enabled: true },
  });
  assert.equal(updated.status, 200);
  const updatedScript = updated.json() as { title: string; tags: string[]; enabled: boolean };
  assert.equal(updatedScript.title, '晚餐与复诊');
  assert.deepEqual(updatedScript.tags, ['复诊']);
  assert.equal(updatedScript.enabled, true);

  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ category: '' }, '空分类'],
    [{ category: '超'.repeat(31) }, '分类超长'],
    [{ title: '   ' }, '空标题'],
    [{ title: '超'.repeat(61) }, '标题超长'],
    [{ content: '' }, '空内容'],
    [{ content: '超'.repeat(2001) }, '内容超长'],
    [
      { tags: Array.from({ length: 6 }, (_, i) => `标签${i}`) },
      '标签过多',
    ],
    [{ tags: ['超'.repeat(11)] }, '标签超长'],
    [{ tags: [1] }, '标签非字符串'],
    [{ enabled: 'yes' }, '启用非布尔'],
    [{}, '无更新字段'],
  ];
  for (const [body, label] of invalid) {
    const res = await call('PATCH', `/zhiban/api/scripts/${script.id}`, { cookie, body });
    assert.equal(res.status, 422, label);
  }
  const invalidCreate = await call('POST', '/zhiban/api/scripts', {
    cookie,
    body: { category: '饮食', title: '晚餐', content: '超'.repeat(2001) },
  });
  assert.equal(invalidCreate.status, 422);

  const patchMissing = await call('PATCH', '/zhiban/api/scripts/scr_404', {
    cookie,
    body: { title: '不存在' },
  });
  assert.equal(patchMissing.status, 404);

  const removed = await call('DELETE', `/zhiban/api/scripts/${script.id}`, { cookie });
  assert.equal(removed.status, 204);
  const afterDelete = await call('GET', '/zhiban/api/scripts?enabled=true', { cookie });
  assert.equal((afterDelete.json() as { total: number }).total, 1);
  const deleteAgain = await call('DELETE', `/zhiban/api/scripts/${script.id}`, { cookie });
  assert.equal(deleteAgain.status, 404);

  const audit = await call('GET', '/zhiban/api/audit?targetType=script', { cookie });
  assert.equal(audit.status, 200);
  const events = (audit.json() as {
    items: Array<{
      action: string;
      targetId: string;
      detail?: Record<string, unknown>;
    }>;
  }).items;
  assert.deepEqual(
    events.map((event) => event.action).sort(),
    ['script.created', 'script.created', 'script.deleted', 'script.updated'],
  );
  const updatedEvent = events.find((event) => event.action === 'script.updated');
  assert.equal(updatedEvent?.targetId, script.id);
  assert.deepEqual(updatedEvent?.detail, {
    category: '饮食',
    title: '晚餐与复诊',
    fields: ['title', 'tags', 'enabled'],
  });
  // 审计只记分类与标题，不落话术正文
  assert.equal(JSON.stringify(events).includes('建议晚餐在 19 点前完成'), false);
  assert.equal(JSON.stringify(events).includes('先确认最近入睡时间'), false);
});

test('话术库：读对全部角色开放，写仅 admin，platform 一律 404', async () => {
  const { call } = await start();
  const admin = await login(call, 'admin', ADMIN_PASSWORD);

  for (const [username, role] of [
    ['supervisor.script', 'supervisor'],
    ['viewer.script', 'viewer'],
  ] as const) {
    const created = await call('POST', '/zhiban/api/accounts', {
      cookie: admin.cookie,
      body: { username, displayName: username, role, password: 'StaffPass123' },
    });
    assert.equal(created.status, 201);
  }

  for (const [username, role] of [
    ['supervisor.script', 'supervisor'],
    ['viewer.script', 'viewer'],
  ] as const) {
    const { cookie } = await login(call, username, 'StaffPass123');
    const readable = await call('GET', '/zhiban/api/scripts', { cookie });
    assert.equal(readable.status, 200, `${role} 应可读`);
    const write = await call('POST', '/zhiban/api/scripts', {
      cookie,
      body: { category: '饮食', title: `${role} 写入`, content: '正文' },
    });
    assert.equal(write.status, 403, `${role} 不应可写`);
    assert.equal((write.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  }

  const platform = await login(call, 'platform', PLATFORM_PASSWORD);
  const platformRead = await call('GET', '/zhiban/api/scripts', { cookie: platform.cookie });
  assert.equal(platformRead.status, 404);
});
