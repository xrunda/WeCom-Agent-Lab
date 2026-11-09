/**
 * #41 / #39 / #40 插件装配单测：用假 DSH 上下文验证路由端到端。
 *
 * 不启动真实宿主、不连接企微；存储用内存领域表，患者 Agent 用假实现。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../plugins/zhiban-console/index.ts';
import type { DshConsoleContext } from '../plugins/zhiban-console/index.ts';

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
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.body += chunk.toString();
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
