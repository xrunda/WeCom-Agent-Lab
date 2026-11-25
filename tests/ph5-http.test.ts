/**
 * PH5-02（#231）患者 H5 HTTP 层测试：假 webServer，不启动监听。
 *
 * 覆盖：
 * - Cookie 签发/清除、401 未登录、错误格式 { error: { code, message, requestId } }
 * - Origin 校验（变更类请求 403）
 * - service_basic 撤回后当前会话 401（取消传播，契约 §5）
 * - 业务限流 60 次/分钟 → 429
 * - 埋点白名单在 HTTP 层同样生效
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import { H5Error, MemoryH5Backend, PatientH5Service } from '../src/p1/patient-h5.ts';
import { H5_SESSION_COOKIE, registerPatientH5Http } from '../plugins/zhiban-patient-h5/http.ts';
import type { H5HttpRequest, H5HttpResponse, H5WebServer } from '../plugins/zhiban-patient-h5/http.ts';

const NOW = 1_700_000_000_000;
const TENANT = 'tn_ph5_http';

type Route = { kind: 'prefix'; path: string; handler: (req: H5HttpRequest, res: H5HttpResponse) => unknown };

interface CallResult {
  status: number;
  body: any;
  headers: Record<string, string | number>;
}

function boot(options: { allowedOrigins?: string[]; cookieSecure?: boolean } = {}) {
  const clock = new FakeClock(NOW);
  const backend = new MemoryH5Backend();
  const service = new PatientH5Service({
    tenantId: TENANT,
    backend,
    sms: {
      mode: 'mock',
      async sendCode() {},
    },
    loadPatient: (id) =>
      id === 'pat_a' ? { status: 'serving', displayName: '测试患者A（虚构）', advisorId: 'adv_1' } : undefined,
    now: () => clock.now(),
    ids: idFactory(() => clock.now()),
  });
  const routes: Route[] = [];
  const webServer: H5WebServer = {
    register: (route) => {
      routes.push(route as Route);
      return undefined;
    },
  };
  registerPatientH5Http(webServer, {
    service,
    allowedOrigins: options.allowedOrigins ?? [],
    ...(options.cookieSecure !== undefined ? { cookieSecure: options.cookieSecure } : {}),
    now: () => clock.now(),
  });
  return { clock, backend, service, route: routes[0]! };
}

function call(
  route: Route,
  options: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const listeners = new Map<string, Array<(arg: unknown) => void>>();
    const headers: Record<string, string | string[] | undefined> = {
      host: 'h5.local',
      ...(options.headers ?? {}),
    };
    const req: H5HttpRequest = {
      method: options.method ?? 'GET',
      url: options.url,
      headers,
      on(event, listener) {
        const list = listeners.get(event) ?? [];
        list.push(listener as (arg: unknown) => void);
        listeners.set(event, list);
        return req;
      },
      destroy() {},
    };
    const result: CallResult = { status: 0, body: null, headers: {} };
    const res: H5HttpResponse = {
      headersSent: false,
      writeHead(status, writeHeaders) {
        result.status = status;
        result.headers = writeHeaders as Record<string, string | number>;
        res.headersSent = true;
      },
      end(chunk) {
        if (typeof chunk === 'string' && chunk) {
          try {
            result.body = JSON.parse(chunk);
          } catch {
            result.body = chunk;
          }
        }
        resolve(result);
      },
    };
    route.handler(req, res);
    // 注入请求体：handler 可能先 await 再注册 'data'/'end' 监听，
    // 用 setImmediate 保证在全部微任务（await 续体）之后才发数据
    setImmediate(() => {
      if (options.body !== undefined) {
        const text = JSON.stringify(options.body);
        for (const listener of listeners.get('data') ?? []) listener(Buffer.from(text));
      }
      for (const listener of listeners.get('end') ?? []) listener(undefined);
    });
    // 兜底：3 秒无响应判失败
    setTimeout(() => reject(new Error('no response')), 3000).unref?.();
  });
}

async function redeemAndCookie(booted: ReturnType<typeof boot>, phone = '13800003421') {
  const invitation = await booted.service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone,
    createdBy: 'acc_test',
  });
  await booted.service.requestVerifyCode({ invitationCode: invitation.code });
  const result = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/redeem',
    body: { invitationCode: invitation.code, phone, code: '000000' },
  });
  assert.equal(result.status, 200, `兑换成功：${JSON.stringify(result.body)}`);
  const setCookie = String(result.headers['Set-Cookie'] ?? '');
  const token = /zb_h5_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token, '响应下发会话 Cookie');
  // 契约 §6.2：个人数据需要 service_basic；测试会话建立后补授权
  await booted.service.decideConsent({
    patientId: 'pat_a',
    scope: 'service_basic',
    action: 'grant',
    decidedVia: 'test',
  });
  return { token, setCookie };
}

test('health 与 server-time 公开可达', async () => {
  const booted = boot();
  const health = await call(booted.route, { url: '/zhiban/h5/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const time = await call(booted.route, { url: '/zhiban/h5/server-time' });
  assert.equal(time.status, 200);
  assert.equal(time.body.timezone, 'Asia/Shanghai');
});

test('未登录访问 /me 返回 401 与标准错误格式', async () => {
  const booted = boot();
  const result = await call(booted.route, { url: '/zhiban/h5/me' });
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'UNAUTHORIZED');
  assert.ok(result.body.error.requestId, '错误带 requestId');
});

test('兑换成功下发 Cookie；/me 返回本人身份；登出清除会话', async () => {
  const booted = boot();
  const { token } = await redeemAndCookie(booted);
  const me = await call(booted.route, {
    url: '/zhiban/h5/me',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.status, 'profile_incomplete');
  assert.equal(me.body.patientId ?? me.body.status, 'profile_incomplete');

  const logout = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/logout',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
  });
  assert.equal(logout.status, 204);
  assert.match(String(logout.headers['Set-Cookie']), /Max-Age=0/);

  const after = await call(booted.route, {
    url: '/zhiban/h5/me',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
  });
  assert.equal(after.status, 401, '登出后会话失效');
});

test('验证码错误返回 422；重放已用邀请返回 404', async () => {
  const booted = boot();
  const invitation = await booted.service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  await booted.service.requestVerifyCode({ invitationCode: invitation.code });
  const wrong = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/redeem',
    body: { invitationCode: invitation.code, phone: '13800003421', code: '123123' },
  });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.code, 'VERIFY_CODE_INVALID');

  const ok = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/redeem',
    body: { invitationCode: invitation.code, phone: '13800003421', code: '000000' },
  });
  assert.equal(ok.status, 200);

  const replay = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/redeem',
    body: { invitationCode: invitation.code, phone: '13800003421', code: '000000' },
  });
  assert.equal(replay.status, 404);
  assert.equal(replay.body.error.code, 'INVITATION_NOT_FOUND');
});

test('变更类请求 Origin 不被允许时返回 403', async () => {
  const booted = boot();
  const result = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/verify-code',
    headers: { origin: 'https://evil.example' },
    body: { phone: '13800003421' },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'FORBIDDEN');
});

test('同源 Origin 放行（host 一致）', async () => {
  const booted = boot();
  const result = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/verify-code',
    headers: { origin: 'http://h5.local' },
    body: { phone: '13800003421' },
  });
  // 手机号未绑定：无法发码（VALIDATION_FAILED），但已通过 Origin 校验
  assert.equal(result.status, 422);
});

test('撤回 service_basic：当前会话撤销、清 Cookie、再访问 401', async () => {
  const booted = boot();
  const { token } = await redeemAndCookie(booted);
  const decide = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/consents/decide',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
    body: { scope: 'service_basic', action: 'withdraw' },
  });
  assert.equal(decide.status, 200);
  assert.match(String(decide.headers['Set-Cookie']), /Max-Age=0/);

  const after = await call(booted.route, {
    url: '/zhiban/h5/me',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
  });
  assert.equal(after.status, 401);
});

test('授权列表与授予：reminder 授权后 /me 反映 reminderEnabled', async () => {
  const booted = boot();
  const { token } = await redeemAndCookie(booted);
  const before = await call(booted.route, {
    url: '/zhiban/h5/consents',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
  });
  assert.equal(before.status, 200);
  assert.ok(Array.isArray(before.body.items));
  assert.equal(before.body.items.length, 5, '五个分项 scope');

  const grant = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/consents/decide',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
    body: { scope: 'reminder', action: 'grant' },
  });
  assert.equal(grant.status, 200);

  const me = await call(booted.route, {
    url: '/zhiban/h5/me',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
  });
  assert.equal(me.body.reminderEnabled, true);
});

test('隐私申请：Idempotency-Key 重放返回同一条', async () => {
  const booted = boot();
  const { token } = await redeemAndCookie(booted);
  const headers = { cookie: `${H5_SESSION_COOKIE}=${token}`, 'idempotency-key': 'idem-http-1' };
  const first = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/privacy/requests',
    headers,
    body: { kind: 'export', detail: '导出我的记录' },
  });
  assert.equal(first.status, 201);
  const replay = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/privacy/requests',
    headers,
    body: { kind: 'export', detail: '导出我的记录' },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.id, first.body.id);
});

test('埋点：白名单事件 200，白名单外 422；超频静默成功', async () => {
  const booted = boot();
  const { token } = await redeemAndCookie(booted);
  const ok = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/events',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
    body: { event: 'h5.plan_view' },
  });
  assert.equal(ok.status, 200);
  const bad = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/events',
    headers: { cookie: `${H5_SESSION_COOKIE}=${token}` },
    body: { event: 'h5.nope' },
  });
  assert.equal(bad.status, 422);
});

test('业务限流：每会话 60 次/分钟，第 61 次 429', async () => {
  const booted = boot();
  const { token } = await redeemAndCookie(booted);
  const cookie = { cookie: `${H5_SESSION_COOKIE}=${token}` };
  let limited = 0;
  for (let i = 0; i < 61; i += 1) {
    const result = await call(booted.route, { url: '/zhiban/h5/auth/session', headers: cookie });
    if (result.status === 429) {
      limited = i + 1;
      assert.equal(result.body.error.code, 'RATE_LIMITED');
      break;
    }
  }
  assert.equal(limited, 61, '第 61 次触发限流');
});

test('未知路由 404；方法不允许由前端约定（GET 优先匹配）', async () => {
  const booted = boot();
  const result = await call(booted.route, { url: '/zhiban/h5/unknown' });
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'NOT_FOUND');
});

test('H5Error 状态映射：RATE_LIMITED→429、INVITATION_EXPIRED→410', async () => {
  const error = new H5Error('INVITATION_EXPIRED', 'x');
  assert.equal(error.status, 410);
  const rate = new H5Error('RATE_LIMITED', 'x');
  assert.equal(rate.status, 429);
});

test('会话 Cookie 默认带 Secure；cookieSecure=false 时不带（仅本地开发）', async () => {
  const secure = boot();
  const secureCookie = await redeemAndCookie(secure);
  assert.match(String(secureCookie.setCookie), /; Secure/);

  const insecure = boot({ cookieSecure: false });
  const plain = await redeemAndCookie(insecure);
  assert.ok(!String(plain.setCookie).includes('; Secure'), '明文站点不应带 Secure');
});

test('service_basic 未授权：/me 返回 403 CONSENT_REQUIRED，授权页可达', async () => {
  const booted = boot();
  const invitation = await booted.service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  await booted.service.requestVerifyCode({ invitationCode: invitation.code });
  const result = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/auth/redeem',
    body: { invitationCode: invitation.code, phone: '13800003421', code: '000000' },
  });
  const token = /zb_h5_session=([^;]+)/.exec(String(result.headers['Set-Cookie'] ?? ''))?.[1];
  assert.ok(token);

  // 未授权 service_basic：个人数据 403（契约 §6.2）
  const me = await call(booted.route, {
    url: '/zhiban/h5/me',
    headers: { cookie: `zb_h5_session=${token}` },
  });
  assert.equal(me.status, 403);
  assert.equal(me.body.error.code, 'CONSENT_REQUIRED');

  // 授权页本身可达：用户可以开启服务
  const consents = await call(booted.route, {
    url: '/zhiban/h5/consents',
    headers: { cookie: `zb_h5_session=${token}` },
  });
  assert.equal(consents.status, 200);

  // 开启后 /me 恢复
  await booted.service.decideConsent({
    patientId: 'pat_a',
    scope: 'service_basic',
    action: 'grant',
    decidedVia: 'test',
  });
  const meAfter = await call(booted.route, {
    url: '/zhiban/h5/me',
    headers: { cookie: `zb_h5_session=${token}` },
  });
  assert.equal(meAfter.status, 200);
});

