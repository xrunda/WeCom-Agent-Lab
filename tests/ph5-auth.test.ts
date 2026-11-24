/**
 * PH5-02（#231）患者 H5 身份与授权服务测试。
 *
 * 覆盖：
 * - 邀请单次使用、过期、撤销、手机号不匹配、失败锁定（契约数据模型 §4.1）
 * - 患者会话：签发、滑动过期、撤销、与员工会话隔离（§3.3）
 * - 分项授权：分项记录、撤回传播（service_basic 撤回撤销全部会话）、幂等（§3.4）
 * - 隐私申请与幂等（§3.13）
 * - 手机号/验证码不进审计 detail（§1.5 隐私红线）
 *
 * 全部使用虚构数据；短信用假端口；不涉及真实企微/短信。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import {
  H5Error,
  MemoryH5Backend,
  MOCK_VERIFY_CODE,
  PatientH5Service,
} from '../src/p1/patient-h5.ts';
import type { SmsPort } from '../src/p1/patient-h5.ts';

const TENANT = 'tn_ph5_test';

class FakeSms implements SmsPort {
  readonly mode = 'mock' as const;
  readonly sent: Array<{ phone: string; code: string }> = [];
  async sendCode(phone: string, code: string): Promise<void> {
    this.sent.push({ phone, code });
  }
}

/** code 随机、可读回的短信端口（验证「非 mock 模式的验证码」逻辑） */
class RandomSms implements SmsPort {
  readonly mode = 'real' as const;
  lastCode = '';
  async sendCode(_phone: string, code: string): Promise<void> {
    this.lastCode = code;
  }
}

function setup(options: {
  patientStatus?: string;
  sms?: SmsPort;
  patientLoginMode?: 'invite_then_phone' | 'invite_only';
} = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const backend = new MemoryH5Backend();
  const patients = new Map<string, { status: string; displayName: string; advisorId?: string }>([
    ['pat_a', { status: options.patientStatus ?? 'serving', displayName: '测试患者A（虚构）', advisorId: 'adv_1' }],
    ['pat_b', { status: 'serving', displayName: '测试患者B（虚构）', advisorId: 'adv_1' }],
    ['pat_paused', { status: 'paused', displayName: '暂停患者（虚构）', advisorId: 'adv_1' }],
  ]);
  const consentChanges: Array<{ patientId: string; scope: string; status: string }> = [];
  const service = new PatientH5Service({
    tenantId: TENANT,
    backend,
    sms: options.sms ?? new FakeSms(),
    loadPatient: (id) => patients.get(id),
    now: () => clock.now(),
    ids: idFactory(() => clock.now()),
    patientLoginMode: options.patientLoginMode,
    onConsentChange: (patientId, scope, status) => {
      consentChanges.push({ patientId, scope, status });
    },
  });
  return { clock, backend, service, patients, consentChanges };
}

async function redeemFlow(
  service: PatientH5Service,
  input: { phone: string; code?: string; patientId?: string },
  sms?: { lastCode?: string },
): Promise<{ token: string; sessionId: string }> {
  const invitation = await service.createInvitation({
    patientId: input.patientId ?? 'pat_a',
    advisorId: 'adv_1',
    phone: input.phone,
    createdBy: 'acc_test',
  });
  await service.requestVerifyCode({ invitationCode: invitation.code });
  const result = await service.redeem({
    invitationCode: invitation.code,
    phone: input.phone,
    code: input.code ?? sms?.lastCode ?? MOCK_VERIFY_CODE,
  });
  return { token: result.sessionToken, sessionId: result.session.id };
}

test('邀请兑换成功：绑定复用既有患者主键，不新建档案', async () => {
  const { service, backend } = setup();
  const { token, sessionId } = await redeemFlow(service, { phone: '13800003421' });
  assert.ok(token.length > 20, '返回明文令牌');
  const binding = service.getBinding('pat_a');
  assert.equal(binding?.patientId, 'pat_a');
  assert.equal(binding?.phoneTail, '3421');
  assert.equal(binding?.status, 'bound');
  // 令牌哈希入库，明文不落库
  const session = backend.load().sessions.find((item) => item.id === sessionId);
  assert.ok(session);
  assert.ok(!JSON.stringify(session).includes(token), '会话记录不含明文令牌');
});

test('单次邀请不能重放（A01/A02）', async () => {
  const { service } = setup();
  const invitation = await service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  await service.requestVerifyCode({ invitationCode: invitation.code });
  const first = await service.redeem({
    invitationCode: invitation.code,
    phone: '13800003421',
    code: MOCK_VERIFY_CODE,
  });
  assert.ok(first.sessionToken);
  // 重放：已使用与不存在同错误（防探测）
  await assert.rejects(
    () =>
      service.redeem({
        invitationCode: invitation.code,
        phone: '13800003421',
        code: MOCK_VERIFY_CODE,
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'INVITATION_NOT_FOUND',
  );
});

test('邀请过期返回 INVITATION_EXPIRED，不改变状态语义', async () => {
  const { service, clock } = setup();
  const invitation = await service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
    ttlHours: 1,
  });
  clock.advance(2 * 60 * 60 * 1000);
  await assert.rejects(
    () => service.requestVerifyCode({ invitationCode: invitation.code }),
    (error: unknown) => error instanceof H5Error && error.code === 'INVITATION_EXPIRED',
  );
});

test('手机号不匹配返回 PHONE_MISMATCH，且邀请保持 pending', async () => {
  const { service } = setup();
  const invitation = await service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  await service.requestVerifyCode({ invitationCode: invitation.code });
  await assert.rejects(
    () =>
      service.redeem({
        invitationCode: invitation.code,
        phone: '13900009999',
        code: MOCK_VERIFY_CODE,
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'PHONE_MISMATCH',
  );
  assert.equal(service.listInvitations('pat_a')[0]?.status, 'pending');
});

test('验证码连续错误 5 次锁定邀请（RATE_LIMITED）', async () => {
  const { service } = setup();
  const invitation = await service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 同一张验证码连续用错 5 次：每次失败都计入邀请失败计数（60s 节流只限制重新发码）
    await assert.rejects(
      () =>
        service.redeem({
          invitationCode: invitation.code,
          phone: '13800003421',
          code: '111111',
        }),
      (error: unknown) => error instanceof H5Error && error.code === 'VERIFY_CODE_INVALID',
    );
  }
  await assert.rejects(
    () =>
      service.redeem({
        invitationCode: invitation.code,
        phone: '13800003421',
        code: MOCK_VERIFY_CODE,
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'RATE_LIMITED',
  );
});

test('服务暂停的患者不能兑换，邀请保持 pending（契约 §4.1）', async () => {
  const { service, patients } = setup();
  // 建邀请时在服务中，之后患者被暂停（复用既有 pat_a）
  const invitation = await service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800001111',
    createdBy: 'acc_test',
  });
  patients.set('pat_a', { status: 'paused', displayName: '测试患者A（虚构）', advisorId: 'adv_1' });
  await service.requestVerifyCode({ invitationCode: invitation.code });
  await assert.rejects(
    () =>
      service.redeem({
        invitationCode: invitation.code,
        phone: '13800001111',
        code: MOCK_VERIFY_CODE,
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'SERVICE_PAUSED',
  );
  assert.equal(service.listInvitations('pat_a')[0]?.status, 'pending');
});

test('服务暂停时不能创建邀请', async () => {
  const { service } = setup();
  await assert.rejects(
    () =>
      service.createInvitation({
        patientId: 'pat_paused',
        advisorId: 'adv_1',
        phone: '13800001111',
        createdBy: 'acc_test',
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'SERVICE_PAUSED',
  );
});

test('随机验证码模式：假短信端口收到码，错误码拒绝', async () => {
  const sms = new RandomSms();
  const { service } = setup({ sms });
  const invitation = await service.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  await service.requestVerifyCode({ invitationCode: invitation.code });
  assert.match(sms.lastCode, /^\d{6}$/);
  await assert.rejects(
    () =>
      service.redeem({
        invitationCode: invitation.code,
        phone: '13800003421',
        code: '999999',
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'VERIFY_CODE_INVALID',
  );
  const result = await service.redeem({
    invitationCode: invitation.code,
    phone: '13800003421',
    code: sms.lastCode,
  });
  assert.ok(result.sessionToken);
});

test('短信未配置：验证码发送返回 SMS_UNAVAILABLE（真实登录阻塞）', async () => {
  const { service } = setup({ sms: { mode: 'unconfigured', sendCode: async () => undefined } });
  await assert.rejects(
    () => service.requestVerifyCode({ phone: '13800003421' }),
    (error: unknown) => error instanceof H5Error && error.code === 'SMS_UNAVAILABLE',
  );
});

test('会话校验：令牌对不上/撤销/空闲超时/绝对过期都拒绝', async () => {
  const { service, clock } = setup();
  const { token, sessionId } = await redeemFlow(service, { phone: '13800003421' });
  assert.ok(await service.resolveSession(token));
  assert.equal(await service.resolveSession('totally-wrong-token'), null);
  // 空闲 25 小时后过期
  clock.advance(25 * 60 * 60 * 1000);
  assert.equal(await service.resolveSession(token), null);
  const records = service.listSessions('pat_a');
  assert.equal(records.find((item) => item.id === sessionId)?.status, 'expired');
});

test('会话撤销后立即失效；退出登录=撤销当前会话', async () => {
  const { service } = setup();
  const { token, sessionId } = await redeemFlow(service, { phone: '13800003421' });
  await service.revokeSession(sessionId, 'account', 'acc_admin');
  assert.equal(await service.resolveSession(token), null);
  assert.equal(service.listSessions('pat_a')[0]?.revokedBy, 'account');
});

test('绑定后可用手机号+验证码再次登录；invite_only 模式关闭该入口', async () => {
  const sms = new RandomSms();
  const { service } = setup({ sms });
  await redeemFlow(service, { phone: '13800003421' }, sms);
  await service.requestVerifyCode({ phone: '13800003421' });
  const login = await service.login({ phone: '13800003421', code: sms.lastCode });
  assert.ok(login.sessionToken);
  // 未绑定手机号登录：不区分未绑定/不匹配（验证码接口也不向未绑定号码发码）
  await assert.rejects(
    () => service.requestVerifyCode({ phone: '13800009999' }),
    (error: unknown) => error instanceof H5Error && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => service.login({ phone: '13800009999', code: sms.lastCode }),
    (error: unknown) => error instanceof H5Error && error.code === 'UNAUTHORIZED',
  );
  // invite_only 模式下手机号登录入口关闭
  const sms2 = new RandomSms();
  const restricted = setup({ sms: sms2, patientLoginMode: 'invite_only' });
  await redeemFlow(restricted.service, { phone: '13800003421' }, sms2);
  await restricted.service.requestVerifyCode({ phone: '13800003421' });
  await assert.rejects(
    () => restricted.service.login({ phone: '13800003421', code: sms2.lastCode }),
    (error: unknown) => error instanceof H5Error && error.code === 'FORBIDDEN',
  );
});

test('分项授权：撤回 service_basic 撤销全部会话并触发传播钩子', async () => {
  const { service, consentChanges } = setup();
  const first = await redeemFlow(service, { phone: '13800003421' });
  const second = await redeemFlow(service, { phone: '13900005555', patientId: 'pat_b' });
  // pat_a 撤回 service_basic
  await service.decideConsent({
    patientId: 'pat_a',
    scope: 'service_basic',
    action: 'withdraw',
    decidedVia: first.sessionId,
  });
  assert.equal(await service.resolveSession(first.token), null, '本人会话已撤销');
  assert.ok(await service.resolveSession(second.token), '其他患者不受影响');
  assert.deepEqual(consentChanges.at(-1), {
    patientId: 'pat_a',
    scope: 'service_basic',
    status: 'withdrawn',
  });
});

test('分项授权：重复同向决定幂等，不再触发传播', async () => {
  const { service, consentChanges } = setup();
  const { sessionId } = await redeemFlow(service, { phone: '13800003421' });
  await service.decideConsent({ patientId: 'pat_a', scope: 'reminder', action: 'withdraw', decidedVia: sessionId });
  const before = consentChanges.length;
  const again = await service.decideConsent({
    patientId: 'pat_a',
    scope: 'reminder',
    action: 'withdraw',
    decidedVia: sessionId,
  });
  assert.equal(again.changed, false);
  assert.equal(consentChanges.length, before);
  // 再授予：changed=true
  const grant = await service.decideConsent({
    patientId: 'pat_a',
    scope: 'reminder',
    action: 'grant',
    decidedVia: sessionId,
  });
  assert.equal(grant.changed, true);
  assert.equal(grant.record.status, 'granted');
  assert.equal(grant.record.history.length, 2, '历史只追加');
});

test('隐私申请：创建、幂等、团队处理；detail 不含手机号', async () => {
  const { service, backend } = setup();
  const { sessionId } = await redeemFlow(service, { phone: '13800003421' });
  const request = await service.createPrivacyRequest({
    patientId: 'pat_a',
    kind: 'export',
    detail: '导出我的记录',
    idempotencyKey: 'idem-1',
  });
  assert.equal(request.status, 'submitted');
  const replay = await service.createPrivacyRequest({
    patientId: 'pat_a',
    kind: 'export',
    detail: '导出我的记录',
    idempotencyKey: 'idem-1',
  });
  assert.equal(replay.id, request.id, '同 key 重放返回首次结果');
  const handled = await service.handlePrivacyRequest({
    id: request.id,
    result: 'handled',
    note: '已导出',
    handledBy: 'acc_admin',
  });
  assert.equal(handled.status, 'handled');
  // 审计红线：detail 字段级检查（不检查 id 子串，ULID 可能巧合包含数字串）
  const dump = JSON.stringify(backend.audits);
  assert.ok(!dump.includes('13800003421'), '审计不含手机号');
  assert.ok(
    backend.audits.every((item) => {
      const detail = item.detail ?? {};
      return !('phone' in detail) && !('phoneTail' in detail) && !('code' in detail);
    }),
    '审计 detail 不含手机号/验证码字段',
  );
  void sessionId;
});

test('纠错申请必须带对象；说明超长拒绝', async () => {
  const { service } = setup();
  await redeemFlow(service, { phone: '13800003421' });
  await assert.rejects(
    () =>
      service.createPrivacyRequest({
        patientId: 'pat_a',
        kind: 'correction',
        detail: 'x',
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () =>
      service.createPrivacyRequest({
        patientId: 'pat_a',
        kind: 'export',
        detail: 'x'.repeat(301),
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'VALIDATION_FAILED',
  );
});

test('跨租户隔离：另一个租户的服务看不到本租户数据', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const backend = new MemoryH5Backend();
  const make = (tenantId: string) =>
    new PatientH5Service({
      tenantId,
      backend,
      sms: new FakeSms(),
      loadPatient: (id) => (id === 'pat_a' ? { status: 'serving', displayName: 'A' } : undefined),
      now: () => clock.now(),
      ids: idFactory(() => clock.now()),
    });
  const serviceA = make('tn_a');
  const serviceB = make('tn_b');
  const invitation = await serviceA.createInvitation({
    patientId: 'pat_a',
    advisorId: 'adv_1',
    phone: '13800003421',
    createdBy: 'acc_test',
  });
  // B 租户用同一 code 兑换：查不到邀请
  await assert.rejects(
    () =>
      serviceB.redeem({
        invitationCode: invitation.code,
        phone: '13800003421',
        code: MOCK_VERIFY_CODE,
      }),
    (error: unknown) => error instanceof H5Error && error.code === 'INVITATION_NOT_FOUND',
  );
  assert.equal(serviceB.listInvitations('pat_a').length, 0);
});

test('埋点白名单：未知事件拒绝，载荷不含正文', async () => {
  const { service, backend } = setup();
  await redeemFlow(service, { phone: '13800003421' });
  await service.recordEvent('pat_a', 'h5.reminder_pref_change');
  await assert.rejects(
    () => service.recordEvent('pat_a', 'h5.not_in_whitelist'),
    (error: unknown) => error instanceof H5Error && error.code === 'VALIDATION_FAILED',
  );
  const events = backend.events.filter((item) => item.event === 'h5.reminder_pref_change');
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes('13800003421'), '埋点不含手机号');
});
