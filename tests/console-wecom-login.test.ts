/**
 * #181 控制台企微扫码登录：state 一次性、换码、账号绑定、会话复核。
 * 全部用假 fetch 与虚构账号，不访问企微、不读取任何真实凭据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConsoleAuthService } from '../plugins/zhiban-console/auth.ts';
import type { AuthActor } from '../plugins/zhiban-console/auth.ts';
import { parseConsoleConfig } from '../plugins/zhiban-console/config.ts';
import {
  WecomLoginError,
  WecomLoginService,
  safeReturnTo,
} from '../plugins/zhiban-console/wecom-login.ts';
import { ConsoleError } from '../src/p1/console-error.ts';
import { ConsoleStore, MemoryConsoleBackend } from '../src/p1/console-store.ts';
import { WecomOAuthClient } from '../src/p1/wecom-oauth.ts';
import type { WecomFetch } from '../src/p1/wecom-oauth.ts';

const PASSWORD = 'AdminPass123';
const BASE = 'https://console.example.com';
const USERID = 'zhang.guwen';

interface FetchHandlers {
  /** code → auth/getuserinfo 响应；缺省返回成功 */
  userinfo?: (code: string) => unknown;
  /** userid → user/get 响应；缺省在职 */
  member?: (userid: string) => unknown;
  /** agent/get 响应；缺省全企业可见 */
  agent?: () => unknown;
  /** 为 true 时所有请求直接抛网络错误 */
  offline?: () => boolean;
}

/** 按企微接口路径分发的假 fetch，避免依赖调用顺序 */
function wecomFetch(handlers: FetchHandlers = {}): { fn: WecomFetch; calls: string[] } {
  const calls: string[] = [];
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const fn: WecomFetch = async (raw) => {
    calls.push(raw);
    if (handlers.offline?.()) {
      const error = new Error('socket hang up');
      error.name = 'FetchError';
      throw error;
    }
    const url = new URL(raw);
    if (url.pathname.endsWith('/gettoken')) {
      return ok({ errcode: 0, access_token: 'token_test', expires_in: 7200 });
    }
    if (url.pathname.endsWith('/auth/getuserinfo')) {
      const code = url.searchParams.get('code') ?? '';
      return ok(handlers.userinfo ? handlers.userinfo(code) : { errcode: 0, userid: USERID });
    }
    if (url.pathname.endsWith('/user/get')) {
      const userid = url.searchParams.get('userid') ?? '';
      return ok(handlers.member ? handlers.member(userid) : { errcode: 0, status: 1, department: [1] });
    }
    if (url.pathname.endsWith('/agent/get')) {
      return ok(
        handlers.agent
          ? handlers.agent()
          : { errcode: 0, allow_userinfos: { user: [] }, allow_partys: { partyid: [] } },
      );
    }
    return ok({ errcode: 0 });
  };
  return { fn, calls };
}

async function setup(handlers: FetchHandlers = {}, start = 1_760_000_000_000) {
  let now = start;
  const store = new ConsoleStore({ backend: new MemoryConsoleBackend(), now: () => now });
  const config = parseConsoleConfig({
    tenantId: 'tn_test',
    tenant: { name: '安康健康管理中心', agentName: '小安' },
    admin: { username: 'admin', displayName: '林主管', password: PASSWORD },
    cookieSecure: false,
    wecom: {
      corpId: 'corp_test',
      agentId: '1000212',
      agentSecret: 'secret_test',
      publicBaseUrl: BASE,
    },
  });
  const auth = new ConsoleAuthService({ store, config, now: () => now });
  await auth.initialize();
  const { fn, calls } = wecomFetch(handlers);
  const oauth = new WecomOAuthClient({
    corpId: 'corp_test',
    agentId: '1000212',
    agentSecret: 'secret_test',
    publicBaseUrl: BASE,
    fetch: fn,
    now: () => now,
  });
  const service = new WecomLoginService({
    oauth,
    config: config.wecom!,
    tenantId: 'tn_test',
    store,
    auth,
    now: () => now,
  });
  const admin = store.findAccountByUsername('admin')!;
  const adminActor: AuthActor = { account: admin, tenant: auth.tenant, tokenHash: 'th_admin' };
  return {
    store,
    config,
    auth,
    service,
    calls,
    adminActor,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    /** 生成一次扫码 state 并取出回调参数 */
    newState: (returnTo: string | null = '/patients') => {
      const url = new URL(service.createQrUrl(returnTo));
      const state = url.searchParams.get('state')!;
      return { url, state };
    },
  };
}

test('扫码 URL 带 appid / agentid / 回调与一次性 state', async () => {
  const { service, newState } = await setup();
  const { url, state } = newState('/patients');

  assert.equal(url.origin, 'https://open.work.weixin.qq.com');
  assert.equal(url.pathname, '/wwopen/sso/qrConnect');
  assert.equal(url.searchParams.get('appid'), 'corp_test');
  // 必须是自建应用 AgentId：智能机器人 Bot ID 不能用于网页授权
  assert.equal(url.searchParams.get('agentid'), '1000212');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    `${BASE}/zhiban/api/auth/wecom/callback`,
  );
  assert.equal(state, url.searchParams.get('state'));
  assert.ok(state.length >= 24);

  const pending = service.consumeState(state);
  assert.equal(pending.mode, 'login');
  assert.equal(pending.returnTo, '/patients');
  // 重放同一个 state 必须失败
  assert.throws(
    () => service.consumeState(state),
    (error: unknown) =>
      error instanceof WecomLoginError && error.reason === 'STATE_INVALID',
  );
});

test('state 5 分钟后过期；未知 state 一律失效', async () => {
  const { service, newState, advance } = await setup();
  const { state } = newState();
  advance(5 * 60_000 + 1);
  assert.throws(
    () => service.consumeState(state),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'STATE_INVALID',
  );
  assert.throws(
    () => service.consumeState('not-a-state'),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'STATE_INVALID',
  );
});

test('登录后跳转只接受站内路径', () => {
  assert.equal(safeReturnTo('/patients?page=2'), '/patients?page=2');
  assert.equal(safeReturnTo('https://evil.example.com'), '/dashboard');
  assert.equal(safeReturnTo('//evil.example.com'), '/dashboard');
  assert.equal(safeReturnTo('/\\evil.example.com'), '/dashboard');
  assert.equal(safeReturnTo('javascript:alert(1)'), '/dashboard');
  assert.equal(safeReturnTo(null), '/dashboard');
  assert.equal(safeReturnTo(''), '/dashboard');
});

test('换码成功返回 userid 与 returnTo；非企业成员归为不在可见范围', async () => {
  const ok = await setup({ userinfo: () => ({ errcode: 0, userid: USERID }) });
  const first = ok.newState('/alerts');
  assert.deepEqual(await ok.service.completeCallback('CODE1', first.state), {
    userid: USERID,
    mode: 'login',
    returnTo: '/alerts',
  });

  const external = await setup({ userinfo: () => ({ errcode: 0, openid: 'openid_x' }) });
  const second = external.newState();
  await assert.rejects(
    external.service.completeCallback('CODE2', second.state),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'OUT_OF_SCOPE',
  );
});

test('换码被企微拒绝：无权限 → 不在可见范围；其它 → 接口异常可重试', async () => {
  const noPrivilege = await setup({
    userinfo: () => ({ errcode: 60011, errmsg: 'no privilege to access/modify contact/party/agent' }),
  });
  const first = noPrivilege.newState();
  await assert.rejects(
    noPrivilege.service.completeCallback('CODE1', first.state),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'OUT_OF_SCOPE',
  );

  const broken = await setup({ userinfo: () => ({ errcode: -1, errmsg: 'system busy' }) });
  const second = broken.newState();
  await assert.rejects(
    broken.service.completeCallback('CODE1', second.state),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'CODE_FAILED',
  );

  const offline = await setup({ offline: () => true });
  const third = offline.newState();
  await assert.rejects(
    offline.service.completeCallback('CODE1', third.state),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'CODE_FAILED',
  );
});

test('未绑定账号不自动建号：403 且账号表不变', async () => {
  const { store, auth } = await setup();
  const before = store.listAccounts().length;
  await assert.rejects(
    auth.loginWithWecom(USERID, '203.0.113.10'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'FORBIDDEN',
  );
  assert.equal(store.listAccounts().length, before);
  assert.equal(store.listSessions().length, 0);
  assert.equal(store.listAccounts().some((item) => item.wecomUserId === USERID), false);
});

test('绑定后的扫码登录签发 8 小时会话，并用 method/wecomUserId 标记', async () => {
  const { auth, store, adminActor, config } = await setup();
  const updated = auth.updateAccount(adminActor, adminActor.account.id, { wecomUserId: USERID });
  assert.equal(updated.wecomUserId, USERID);

  const result = await auth.loginWithWecom(USERID, '203.0.113.10');
  assert.equal(result.session.method, 'wecom');
  assert.equal(result.session.wecomUserId, USERID);
  assert.equal(result.session.expiresAt - result.session.createdAt, 8 * 60 * 60 * 1000);
  assert.equal(result.session.expiresAt - result.session.createdAt, config.wecom!.sessionTtlMs);

  // 密码登录仍是 7 天，不受扫码会话 TTL 影响
  const password = await auth.login('admin', PASSWORD, '203.0.113.10');
  assert.equal(password.session.expiresAt - password.session.createdAt, 7 * 24 * 60 * 60 * 1000);
  assert.equal(password.session.method, 'password');
  assert.equal(store.listSessions().length, 2);
});

test('停用账号不能扫码登录', async () => {
  const { auth, adminActor } = await setup();
  auth.updateAccount(adminActor, adminActor.account.id, { wecomUserId: USERID });
  // 自己不能停用自己，直接改存储模拟管理员被他人停用
  const record = auth.listAccounts().find((item) => item.username === 'admin')!;
  auth.updateAccount(
    { ...adminActor, account: { ...adminActor.account, id: 'acc_other' } },
    record.id,
    { status: 'disabled' },
  );
  await assert.rejects(
    auth.loginWithWecom(USERID, '203.0.113.10'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'ACCOUNT_DISABLED',
  );
});

test('企微 userid 一个账号只能绑一次', async () => {
  const { auth, adminActor, store } = await setup();
  auth.updateAccount(adminActor, adminActor.account.id, { wecomUserId: USERID });
  const created = await auth.createAccount(adminActor, {
    username: 'advisor01',
    displayName: '张顾问',
    role: 'viewer',
    password: 'AdvisorPass123',
  });
  assert.throws(
    () => auth.updateAccount(adminActor, created.id, { wecomUserId: USERID }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
  await assert.rejects(
    auth.createAccount(adminActor, {
      username: 'advisor02',
      displayName: '李顾问',
      role: 'viewer',
      password: 'AdvisorPass123',
      wecomUserId: USERID,
    }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
  // 解绑后可以重新绑定
  auth.updateAccount(adminActor, adminActor.account.id, { wecomUserId: null });
  const rebound = auth.updateAccount(adminActor, created.id, { wecomUserId: USERID });
  assert.equal(rebound.wecomUserId, USERID);
  assert.equal(store.findAccountByUsername('admin')!.wecomUserId, undefined);
});

test('扫码绑定：把扫码得到的 userid 绑到发起绑定的账号（#183）', async () => {
  const { auth, service, store } = await setup();
  const login = await auth.login('admin', PASSWORD, '203.0.113.10');
  const url = new URL(
    service.createBindUrl({
      accountId: login.account.id,
      sessionHash: login.session.tokenHash,
    }),
  );
  assert.equal(url.searchParams.get('agentid'), '1000212');

  const result = await service.completeCallback(
    'CODE1',
    url.searchParams.get('state')!,
  );
  assert.equal(result.mode, 'bind');
  assert.equal(result.returnTo, '/settings/accounts');
  const bound = service.assertBindSession(result);
  assert.equal(bound.accountId, login.account.id);

  const updated = auth.bindWecom(bound.accountId, result.userid);
  assert.equal(updated.wecomUserId, USERID);
  assert.equal(store.findAccountByUsername('admin')!.wecomUserId, USERID);
});

test('扫码绑定：发起会话退出后回调不认；userid 已被占用 → CONFLICT', async () => {
  const { auth, service, store, adminActor } = await setup();
  const login = await auth.login('admin', PASSWORD, '203.0.113.10');
  const stateOf = (tokenHash: string): string =>
    new URL(
      service.createBindUrl({ accountId: login.account.id, sessionHash: tokenHash }),
    ).searchParams.get('state')!;

  // 会话退出后，同一个 state 回调必须失效，且错误标记为 bind 流程
  const first = await service.completeCallback('CODE1', stateOf(login.session.tokenHash));
  auth.logout(login.session.tokenHash, {
    account: login.account,
    tenant: auth.tenant,
    tokenHash: login.session.tokenHash,
  } as AuthActor);
  assert.throws(
    () => service.assertBindSession(first),
    (error: unknown) =>
      error instanceof WecomLoginError &&
      error.reason === 'STATE_INVALID' &&
      error.mode === 'bind',
  );

  // userid 已绑在别的账号上：扫码绑定不能抢绑定
  const other = await auth.createAccount(adminActor, {
    username: 'advisor02',
    displayName: '李顾问',
    role: 'viewer',
    password: 'AdvisorPass123',
    wecomUserId: USERID,
  });
  assert.throws(
    () => auth.bindWecom(store.findAccountByUsername('admin')!.id, USERID),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
  assert.equal(store.getAccount(other.id)!.wecomUserId, USERID);
});

test('扫码绑定：不在可见范围时失败仍带 bind 标记，state 过期给 expired 口径', async () => {
  const scoped = await setup({ userinfo: () => ({ errcode: 60011, errmsg: 'no privilege' }) });
  const login = await scoped.auth.login('admin', PASSWORD, '203.0.113.10');
  const state = new URL(
    scoped.service.createBindUrl({
      accountId: login.account.id,
      sessionHash: login.session.tokenHash,
    }),
  ).searchParams.get('state')!;
  await assert.rejects(
    scoped.service.completeCallback('CODE1', state),
    (error: unknown) =>
      error instanceof WecomLoginError &&
      error.reason === 'OUT_OF_SCOPE' &&
      error.mode === 'bind',
  );

  const expired = await setup();
  const session = await expired.auth.login('admin', PASSWORD, '203.0.113.10');
  const expiredState = new URL(
    expired.service.createBindUrl({
      accountId: session.account.id,
      sessionHash: session.session.tokenHash,
    }),
  ).searchParams.get('state')!;
  expired.advance(5 * 60_000 + 1);
  assert.throws(
    () => expired.service.consumeState(expiredState),
    (error: unknown) => error instanceof WecomLoginError && error.reason === 'STATE_INVALID',
  );
});

test('会话复核：移出可见范围 / 离职 → 作废；接口抖动 → 保留', async () => {
  const context = await setup({
    member: (userid) =>
      userid === 'left.user'
        ? { errcode: 60111, errmsg: 'user not found' }
        : { errcode: 0, status: 1, department: [7] },
    agent: () => ({
      errcode: 0,
      allow_userinfos: { user: [{ userid: USERID }] },
      allow_partys: { partyid: [] },
    }),
  });
  const { auth, adminActor, service, store, advance } = context;
  auth.updateAccount(adminActor, adminActor.account.id, { wecomUserId: USERID });

  const stays = await auth.loginWithWecom(USERID, '203.0.113.10');
  const leaves = await auth.loginWithWecom(USERID, '203.0.113.10');
  // 第二条会话模拟另一位成员：同账号两条会话，靠标记区分复核结果
  store.saveSession({ ...leaves.session, wecomUserId: 'left.user' });

  advance(6 * 60_000);
  const revoked = await service.recheckSessions();
  assert.equal(revoked, 1);
  assert.ok(store.getSession(stays.session.tokenHash));
  assert.equal(store.getSession(leaves.session.tokenHash), undefined);
});

test('会话复核：应用可见范围不含该成员 → 作废；只按标签授权无法判定 → 保留', async () => {
  const scoped = await setup({
    member: () => ({ errcode: 0, status: 1, department: [3] }),
    agent: () => ({
      errcode: 0,
      allow_userinfos: { user: [{ userid: 'someone.else' }] },
      allow_partys: { partyid: [9] },
    }),
  });
  scoped.auth.updateAccount(scoped.adminActor, scoped.adminActor.account.id, {
    wecomUserId: USERID,
  });
  await scoped.auth.loginWithWecom(USERID, '203.0.113.10');
  scoped.advance(6 * 60_000);
  assert.equal(await scoped.service.recheckSessions(), 1);

  const byTag = await setup({
    member: () => ({ errcode: 0, status: 1, department: [3] }),
    agent: () => ({
      errcode: 0,
      allow_userinfos: { user: [] },
      allow_partys: { partyid: [] },
      allow_tags: { tagid: [5] },
    }),
  });
  byTag.auth.updateAccount(byTag.adminActor, byTag.adminActor.account.id, { wecomUserId: USERID });
  await byTag.auth.loginWithWecom(USERID, '203.0.113.10');
  byTag.advance(6 * 60_000);
  assert.equal(await byTag.service.recheckSessions(), 0);

  const offline = await setup({ offline: () => true });
  offline.auth.updateAccount(offline.adminActor, offline.adminActor.account.id, {
    wecomUserId: USERID,
  });
  await offline.auth.loginWithWecom(USERID, '203.0.113.10');
  offline.advance(6 * 60_000);
  // 企微接口抖动时不踢人；8 小时后会话自然过期
  assert.equal(await offline.service.recheckSessions(), 0);
});

test('复核结果缓存 5 分钟：同一成员一轮只查一次', async () => {
  const { auth, adminActor, service, store, calls, advance } = await setup();
  auth.updateAccount(adminActor, adminActor.account.id, { wecomUserId: USERID });
  const sessions: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    sessions.push((await auth.loginWithWecom(USERID, '203.0.113.10')).session.tokenHash);
  }

  const before = calls.filter((url) => url.includes('/user/get')).length;
  advance(6 * 60_000);
  await service.recheckSessions();
  const after = calls.filter((url) => url.includes('/user/get')).length;

  // 三条会话属于同一成员：一轮复核只查一次，其余命中缓存
  assert.equal(after - before, 1);
  for (const hash of sessions) assert.ok(store.getSession(hash));
});
