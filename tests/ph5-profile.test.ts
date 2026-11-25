/**
 * PH5-03（#232）轻量建档与食养主张测试。
 *
 * 覆盖（契约数据模型 §3.5 / api §4、§9.1；issue #232 验收）：
 * - 分步提交、字段校验、「不清楚」合法、来源与确认状态
 * - 安全规则：allergy 缺失 → safetyMissing；自述与专业确认冲突 → data_pending；
 *   professional 条目不被患者提交覆盖（并列草稿）
 * - meStatus 状态流转：profile_incomplete → plan_generating / service_paused
 * - HTTP 扩展路由：/manifesto 公开、/profile 需会话、未知步骤 422
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import { MemoryH5Backend, PatientH5Service } from '../src/p1/patient-h5.ts';
import {
  MemoryProfileBackend,
  ProfileService,
  ProfileValidationError,
  validateFieldValue,
} from '../src/p1/patient-h5-profile.ts';
import type { ProfileEntry } from '../src/p1/patient-h5-profile.ts';
import { registerPatientH5Http } from '../plugins/zhiban-patient-h5/http.ts';
import type { H5HttpRequest, H5HttpResponse, H5WebServer } from '../plugins/zhiban-patient-h5/http.ts';
import { createProfileRoutes, DEFAULT_MANIFESTO } from '../plugins/zhiban-patient-h5/routes/profile.ts';

const NOW = 1_700_000_000_000;
const TENANT = 'tn_ph5_profile';

function setupService() {
  const clock = new FakeClock(NOW);
  const profileBackend = new MemoryProfileBackend();
  const patients = new Map<string, { status: string; displayName: string; advisorId?: string }>([
    ['pat_a', { status: 'serving', displayName: '测试患者A（虚构）', advisorId: 'adv_1' }],
  ]);
  const service = new PatientH5Service({
    tenantId: TENANT,
    backend: new MemoryH5Backend(),
    sms: { mode: 'mock', async sendCode() {} },
    loadPatient: (id) => patients.get(id),
    now: () => clock.now(),
    ids: idFactory(() => clock.now()),
  });
  const profile = new ProfileService({
    backend: profileBackend,
    tenantId: TENANT,
    ids: idFactory(() => clock.now()),
  });
  return { clock, profileBackend, service, profile, patients };
}

async function answer(
  profile: ProfileService,
  step: 'basics' | 'routine' | 'food' | 'safety' | 'guidance',
  answers: Record<string, Record<string, unknown>>,
): Promise<void> {
  await profile.submitAnswers({ patientId: 'pat_a', step, answers, decidedVia: 'session_1' });
}

test('分步建档：六字段齐备后进入 plan_generating（准备中）', async () => {
  const { profile } = setupService();
  assert.equal(profile.meStatus('pat_a', 'serving'), 'profile_incomplete');
  await answer(profile, 'basics', { goal: { items: ['改善睡眠'] } });
  await answer(profile, 'routine', {
    meal_times: { breakfast: '07:00', lunch: '12:00', dinner: '18:30' },
    sleep_time: { bedtime: '22:30', waketime: '06:30' },
  });
  await answer(profile, 'food', { food_preference: { likes: ['清淡'], dislikes: ['辛辣'] } });
  // allergy 未填：safetyMissing → 仍 profile_incomplete
  assert.equal(profile.status('pat_a').safetyMissing, true);
  assert.equal(profile.meStatus('pat_a', 'serving'), 'profile_incomplete');
  await answer(profile, 'safety', { allergy: { items: ['海鲜（自述）'], unknown: false } });
  await answer(profile, 'guidance', { existing_guidance: { items: ['低盐饮食'], sourceNote: '门诊 2026-10' } });
  const status = profile.status('pat_a');
  assert.equal(status.completeness, 1);
  assert.equal(status.safetyMissing, false);
  assert.equal(status.conflicts.length, 0);
  // PH5-04 未落地：资料齐全 → 统一「正在为你准备计划」
  assert.equal(profile.meStatus('pat_a', 'serving'), 'plan_generating');
  // 服务暂停优先
  assert.equal(profile.meStatus('pat_a', 'paused'), 'service_paused');
});

test('「不清楚」是合法取值，且不解除 safetyMissing 之外的缺失口径', async () => {
  const { profile } = setupService();
  await answer(profile, 'safety', { allergy: { unknown: true } });
  const entry = profile.find('pat_a', 'allergy');
  assert.equal(entry?.value.unknown, true);
  assert.equal(entry?.valueText, '不清楚（待补充）');
  // unknown=true 视为「已回答但待补充」：safetyMissing 不再为 true（A03：允许不清楚）
  assert.equal(profile.status('pat_a').safetyMissing, false);
});

test('字段校验：时间格式、数组上限、unknown 必填', () => {
  assert.ok(validateFieldValue('goal', { items: ['改善睡眠'] }).length === 0);
  assert.ok(validateFieldValue('goal', { items: '' }).length > 0);
  assert.ok(validateFieldValue('meal_times', { breakfast: '7点' }).length > 0);
  assert.ok(validateFieldValue('allergy', { items: [] }).length > 0, 'unknown 必填');
  assert.ok(validateFieldValue('allergy', { unknown: 'yes' }).length > 0);
});

test('未知步骤与未知字段被拒绝', async () => {
  const { profile } = setupService();
  await assert.rejects(
    () =>
      profile.submitAnswers({
        patientId: 'pat_a',
        step: 'nope' as 'basics',
        answers: { goal: { items: ['x'] } },
        decidedVia: 's',
      }),
    (error: unknown) => error instanceof Error && /未知步骤/.test(error.message),
  );
  await assert.rejects(
    () =>
      profile.submitAnswers({
        patientId: 'pat_a',
        step: 'basics',
        answers: { height: { cm: 170 } } as never,
        decidedVia: 's',
      }),
    (error: unknown) => error instanceof ProfileValidationError,
  );
});

test('专业确认条目不被患者提交覆盖（并列草稿，进入 conflicts）', async () => {
  const { profileBackend, profile } = setupService();
  // 预置一条 professional 确认的既有指导
  const professional: ProfileEntry = {
    id: 'ppe_pro_1',
    tenantId: TENANT,
    patientId: 'pat_a',
    fieldKey: 'existing_guidance',
    value: { items: ['低嘌呤饮食（门诊医嘱）'] },
    valueText: '低嘌呤饮食（门诊医嘱）',
    source: 'professional',
    status: 'confirmed',
    confirmedBy: 'acc_pro',
    confirmedAt: NOW,
    updatedAt: NOW,
    revisions: [],
  };
  await profileBackend.putProfileEntry(professional);

  // 先补齐 allergy（safety），让冲突成为唯一阻断因素
  await answer(profile, 'safety', { allergy: { items: ['海鲜（自述）'], unknown: false } });
  await answer(profile, 'guidance', { existing_guidance: { items: ['没接受过特别指导'] } });

  const entries = profile.list('pat_a').filter((item) => item.fieldKey === 'existing_guidance');
  assert.equal(entries.length, 2, '专业条目保留 + 患者草稿并列');
  assert.ok(entries.some((item) => item.source === 'professional'));
  assert.ok(entries.some((item) => item.source === 'patient' && item.status === 'draft'));
  const status = profile.status('pat_a');
  assert.equal(status.conflicts.length, 1);
  assert.match(status.conflicts[0]!.detail, /不一致/);
  // 冲突 → data_pending（A03：不进入可执行建议）
  assert.equal(profile.meStatus('pat_a', 'serving'), 'data_pending');
});

test('患者确认既有条目后状态置 confirmed（不改变来源）', async () => {
  const { profileBackend, profile } = setupService();
  const draft: ProfileEntry = {
    id: 'ppe_draft_1',
    tenantId: TENANT,
    patientId: 'pat_a',
    fieldKey: 'goal',
    value: { items: ['控制体重'] },
    valueText: '控制体重',
    source: 'advisor',
    status: 'draft',
    updatedAt: NOW,
    revisions: [],
  };
  await profileBackend.putProfileEntry(draft);
  const confirmed = await profile.confirm('pat_a', ['ppe_draft_1'], 'session_2');
  assert.equal(confirmed[0]?.status, 'confirmed');
  assert.equal(confirmed[0]?.source, 'advisor', '来源不被确认动作改写');
});

// ---------- HTTP 扩展路由 ----------

type Route = {
  kind: 'prefix';
  path: string;
  handler: (req: H5HttpRequest, res: H5HttpResponse) => unknown;
};

function bootHttp() {
  const base = setupService();
  const routes: Route[] = [];
  const webServer: H5WebServer = {
    register: (route) => {
      routes.push(route as Route);
      return undefined;
    },
  };
  registerPatientH5Http(webServer, {
    service: base.service,
    allowedOrigins: [],
    now: () => base.clock.now(),
    extensions: createProfileRoutes({ profile: base.profile }),
    composeMe: (view) => ({
      status: base.profile.meStatus(view.session.patientId, view.patient.status),
      profile: base.profile.status(view.session.patientId),
    }),
  });
  return { ...base, route: routes[0]! };
}

function call(
  route: Route,
  options: { method?: string; url: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any; headers: Record<string, string | number> }> {
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
    const result: { status: number; body: any; headers: Record<string, string | number> } = { status: 0, body: null, headers: {} };
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
    setImmediate(() => {
      if (options.body !== undefined) {
        const text = JSON.stringify(options.body);
        for (const listener of listeners.get('data') ?? []) listener(Buffer.from(text));
      }
      for (const listener of listeners.get('end') ?? []) listener(undefined);
    });
    setTimeout(() => reject(new Error('no response')), 3000).unref?.();
  });
}

async function sessionCookie(booted: ReturnType<typeof bootHttp>): Promise<string> {
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
  assert.ok(token, '兑换成功');
  // 契约 §6.2：个人数据需要 service_basic；测试会话建立后补授权
  await booted.service.decideConsent({
    patientId: 'pat_a',
    scope: 'service_basic',
    action: 'grant',
    decidedVia: 'test',
  });
  return `zb_h5_session=${token}`;
}

test('/manifesto 公开可达，返回默认主张（含出处标注结构）', async () => {
  const booted = bootHttp();
  const result = await call(booted.route, { url: '/zhiban/h5/manifesto' });
  assert.equal(result.status, 200);
  assert.equal(result.body.version, DEFAULT_MANIFESTO.version);
  const quote = result.body.sections.find(
    (item: { kind: string }) => item.kind === 'classic_quote',
  );
  assert.ok(quote.citation, '经典引用带出处');
});

test('/profile 未登录 401；登录后返回空档案', async () => {
  const booted = bootHttp();
  const denied = await call(booted.route, { url: '/zhiban/h5/profile' });
  assert.equal(denied.status, 401);

  const cookie = await sessionCookie(booted);
  const okResult = await call(booted.route, {
    url: '/zhiban/h5/profile',
    headers: { cookie },
  });
  assert.equal(okResult.status, 200);
  assert.deepEqual(okResult.body.items, []);
  assert.equal(okResult.body.status.completeness, 0);
});

test('PUT /profile/answers：建档成功并反映到 /me 状态', async () => {
  const booted = bootHttp();
  const cookie = await sessionCookie(booted);

  const submit = await call(booted.route, {
    method: 'PUT',
    url: '/zhiban/h5/profile/answers',
    headers: { cookie },
    body: { step: 'safety', answers: { allergy: { items: ['海鲜（自述）'], unknown: false } } },
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  assert.equal(submit.body.entries.length, 1);
  assert.equal(submit.body.entries[0].source, 'patient');

  const me = await call(booted.route, { url: '/zhiban/h5/me', headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.profile.safetyMissing, false);
  assert.equal(me.body.status, 'profile_incomplete');
});

test('PUT /profile/answers：未知步骤 422；字段校验失败 422 带字段', async () => {
  const booted = bootHttp();
  const cookie = await sessionCookie(booted);
  const badStep = await call(booted.route, {
    method: 'PUT',
    url: '/zhiban/h5/profile/answers',
    headers: { cookie },
    body: { step: 'nope', answers: {} },
  });
  assert.equal(badStep.status, 422);
  assert.equal(badStep.body.error.code, 'VALIDATION_FAILED');

  const badValue = await call(booted.route, {
    method: 'PUT',
    url: '/zhiban/h5/profile/answers',
    headers: { cookie },
    body: { step: 'routine', answers: { meal_times: { breakfast: '早上七点' } } },
  });
  assert.equal(badValue.status, 422);
  assert.equal(badValue.body.error.details[0].field, 'meal_times');
});

test('POST /profile/confirm：确认既有条目', async () => {
  const booted = bootHttp();
  const cookie = await sessionCookie(booted);
  const submit = await call(booted.route, {
    method: 'PUT',
    url: '/zhiban/h5/profile/answers',
    headers: { cookie },
    body: { step: 'basics', answers: { goal: { items: ['改善睡眠'] } } },
  });
  const entryId = submit.body.entries[0].id;
  const confirm = await call(booted.route, {
    method: 'POST',
    url: '/zhiban/h5/profile/confirm',
    headers: { cookie },
    body: { entryIds: [entryId] },
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.items[0].status, 'confirmed');
});
