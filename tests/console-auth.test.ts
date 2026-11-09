/**
 * #41 认证与会话单测：口令哈希、登录限流、Cookie 会话、账号管理。
 * 全部数据为虚构；不读取任何真实凭据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BusinessRateLimiter,
  hashPassword,
  LoginLimiter,
  validatePassword,
  verifyPassword,
} from '../src/p1/console-auth.ts';
import { ConsoleError } from '../src/p1/console-error.ts';
import { ConsoleStore, MemoryConsoleBackend } from '../src/p1/console-store.ts';
import { ConsoleAuthService, publicAccount } from '../plugins/zhiban-console/auth.ts';
import { parseConsoleConfig } from '../plugins/zhiban-console/config.ts';
import type { HttpRequestLike } from '../plugins/zhiban-console/http.ts';

const PASSWORD = 'AdminPass123';
const PLATFORM_PASSWORD = 'PlatformPass123';

function fakeRequest(cookie?: string): HttpRequestLike {
  return {
    method: 'GET',
    url: '/zhiban/api/auth/session',
    headers: cookie ? { cookie } : {},
    on() {
      return undefined;
    },
  };
}

async function setup(start = 1_760_000_000_000) {
  let now = start;
  const store = new ConsoleStore({ backend: new MemoryConsoleBackend(), now: () => now });
  const config = parseConsoleConfig({
    tenantId: 'tn_test',
    tenant: { name: '安康健康管理中心', agentName: '小安' },
    admin: { username: 'admin', displayName: '林主管', password: PASSWORD },
    platform: { username: 'platform', displayName: '平台运营', password: PLATFORM_PASSWORD },
    cookieSecure: false,
  });
  const auth = new ConsoleAuthService({ store, config, now: () => now });
  await auth.initialize();
  return {
    store,
    config,
    auth,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test('scrypt 哈希可校验，格式不自带明文', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(hash.includes(PASSWORD), false);
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword('WrongPass123', hash), false);
});

test('口令规则：至少 10 位且含字母与数字', () => {
  assert.ok(validatePassword('short1'));
  assert.ok(validatePassword('onlyletters'));
  assert.ok(validatePassword('1234567890'));
  assert.equal(validatePassword('GoodPass123'), null);
});

test('登录失败 5 次后按 IP + 用户名锁定，成功登录清零', () => {
  const limiter = new LoginLimiter(5, 15 * 60_000);
  const now = 1_000;
  assert.equal(limiter.retryAfterSeconds('1.2.3.4', 'admin', now), 0);
  for (let index = 0; index < 5; index += 1) limiter.fail('1.2.3.4', 'admin', now);
  assert.ok(limiter.retryAfterSeconds('1.2.3.4', 'admin', now) > 0);
  // 其它 IP / 用户名不受影响
  assert.equal(limiter.retryAfterSeconds('5.6.7.8', 'admin', now), 0);
  assert.equal(limiter.retryAfterSeconds('1.2.3.4', 'other', now), 0);
  limiter.reset('1.2.3.4', 'admin');
  assert.equal(limiter.retryAfterSeconds('1.2.3.4', 'admin', now), 0);
});

test('业务限流：每账号每分钟 120 次，跨窗口恢复', () => {
  const limiter = new BusinessRateLimiter();
  const now = 1_000_000;
  for (let index = 0; index < 120; index += 1) {
    assert.equal(limiter.retryAfterSeconds('acc_1', now), 0, `第 ${index + 1} 次`);
  }
  assert.ok(limiter.retryAfterSeconds('acc_1', now) > 0);
  assert.equal(limiter.retryAfterSeconds('acc_2', now), 0);
  assert.equal(limiter.retryAfterSeconds('acc_1', now + 60_000), 0);
});

test('初始化只种一个租户与部署账号，密码不进入对外视图', async () => {
  const { store, auth } = await setup();
  assert.equal(store.listTenants().length, 1);
  assert.equal(store.listAccounts().length, 2);

  const account = store.findAccountByUsername('admin');
  assert.ok(account);
  assert.equal('passwordHash' in publicAccount(account!), false);
  assert.equal(auth.sessionView({
    account: account!,
    tenant: store.getTenant('tn_test')!,
    tokenHash: 'x',
  }).account.role, 'admin');
});

test('登录成功签发 Cookie 会话，可被解析；错误密码记失败审计', async () => {
  const { auth, store } = await setup();
  const result = await auth.login('admin', PASSWORD, '203.0.113.9');
  assert.equal(result.account.username, 'admin');
  assert.equal(result.tenant?.id, 'tn_test');
  assert.ok(result.token.length >= 32);

  const resolved = auth.resolve(fakeRequest(`zhiban_session=${result.token}`));
  assert.equal(resolved?.account.id, result.account.id);
  assert.equal(resolved?.tenant?.name, '安康健康管理中心');

  await assert.rejects(
    () => auth.login('admin', 'WrongPass123', '203.0.113.9'),
    (error: unknown) =>
      error instanceof ConsoleError && error.code === 'INVALID_CREDENTIALS',
  );
  const failures = store.listAudits().filter((event) => event.action === 'auth.login' && event.result === 'failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.ip, '203.0.113.*');
});

test('连续失败 5 次后，即使密码正确也返回 RATE_LIMITED', async () => {
  const { auth } = await setup();
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(() => auth.login('admin', 'WrongPass123', '198.51.100.7'));
  }
  await assert.rejects(
    () => auth.login('admin', PASSWORD, '198.51.100.7'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'RATE_LIMITED',
  );
});

test('停用账号不能登录；平台账号登录后没有租户', async () => {
  const { auth, store } = await setup();
  const adminLogin = await auth.login('admin', PASSWORD, '10.0.0.1');
  const viewer = await auth.createAccount(
    { account: adminLogin.account, tenant: adminLogin.tenant, tokenHash: 'x' },
    {
      username: 'viewer.one',
      displayName: '只读一号',
      role: 'viewer',
      password: 'ViewerPass123',
    },
  );
  auth.updateAccount(
    { account: adminLogin.account, tenant: adminLogin.tenant, tokenHash: 'x' },
    viewer.id,
    { status: 'disabled' },
  );
  await assert.rejects(
    () => auth.login('viewer.one', 'ViewerPass123', '10.0.0.2'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'ACCOUNT_DISABLED',
  );

  const platform = await auth.login('platform', PLATFORM_PASSWORD, '10.0.0.3');
  assert.equal(platform.tenant, null);
  assert.equal(store.getAccount(platform.account.id)?.tenantId, null);
});

test('会话过期即失效；登出删除服务端会话', async () => {
  const { auth, advance } = await setup();
  const login = await auth.login('admin', PASSWORD, '10.0.0.1');
  assert.ok(auth.resolve(fakeRequest(`zhiban_session=${login.token}`)));
  advance(8 * 24 * 60 * 60 * 1000);
  assert.equal(auth.resolve(fakeRequest(`zhiban_session=${login.token}`)), undefined);

  const second = await auth.login('admin', PASSWORD, '10.0.0.1');
  const actor = auth.resolve(fakeRequest(`zhiban_session=${second.token}`))!;
  auth.logout(actor.tokenHash, actor);
  assert.equal(auth.resolve(fakeRequest(`zhiban_session=${second.token}`)), undefined);
});

test('改密保留当前会话、撤销其它设备会话', async () => {
  const { auth } = await setup();
  const first = await auth.login('admin', PASSWORD, '10.0.0.1');
  const second = await auth.login('admin', PASSWORD, '10.0.0.2');
  const actor = auth.resolve(fakeRequest(`zhiban_session=${first.token}`))!;
  await auth.changePassword(actor, PASSWORD, 'NewAdminPass456');

  assert.ok(auth.resolve(fakeRequest(`zhiban_session=${first.token}`)));
  assert.equal(auth.resolve(fakeRequest(`zhiban_session=${second.token}`)), undefined);
  assert.ok(auth.resolve(fakeRequest(`zhiban_session=${first.token}`)));

  const login = await auth.login('admin', 'NewAdminPass456', '10.0.0.3');
  assert.equal(login.account.id, actor.account.id);
});

test('账号管理：用户名冲突、不能停用/删除自己、软删除后登录失败', async () => {
  const { auth, store } = await setup();
  const login = await auth.login('admin', PASSWORD, '10.0.0.1');
  const actor = auth.resolve(fakeRequest(`zhiban_session=${login.token}`))!;

  await assert.rejects(
    () =>
      auth.createAccount(actor, {
        username: 'ADMIN',
        displayName: '重复',
        role: 'viewer',
        password: 'ViewerPass123',
      }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );

  const created = await auth.createAccount(actor, {
    username: 'sup.one',
    displayName: '主管一号',
    role: 'supervisor',
    password: 'SuperPass123',
  });
  assert.equal(created.role, 'supervisor');

  assert.throws(
    () => auth.updateAccount(actor, actor.account.id, { status: 'disabled' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );
  assert.throws(
    () => auth.deleteAccount(actor, actor.account.id),
    (error: unknown) => error instanceof ConsoleError && error.code === 'CONFLICT',
  );

  auth.deleteAccount(actor, created.id);
  assert.equal(store.getAccount(created.id)?.deletedAt !== undefined, true);
  assert.equal(auth.listAccounts().some((account) => account.id === created.id), false);
  await assert.rejects(() => auth.login('sup.one', 'SuperPass123', '10.0.0.5'));
});

test('平台账号不出现在租户账号列表，也不能被租户管理员修改', async () => {
  const { auth, store } = await setup();
  const login = await auth.login('admin', PASSWORD, '10.0.0.1');
  const actor = auth.resolve(fakeRequest(`zhiban_session=${login.token}`))!;
  const platform = store.findAccountByUsername('platform')!;

  assert.equal(auth.listAccounts().some((account) => account.role === 'platform'), false);
  assert.throws(
    () => auth.updateAccount(actor, platform.id, { status: 'disabled' }),
    (error: unknown) => error instanceof ConsoleError && error.code === 'NOT_FOUND',
  );
});
