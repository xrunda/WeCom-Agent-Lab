/**
 * /today 与 /me 的陪伴天数接线测试。
 *
 * 真实接口此前把 companionDays 固定为 null，今天页显示「陪伴你的第 — 天」，
 * 而我的页有真实天数——同一个事实两处不一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCalendarRoutes } from '../plugins/zhiban-patient-h5/routes/calendar.ts';
import type { H5RouteContext } from '../plugins/zhiban-patient-h5/http.ts';

/** 只提供路由需要的那几个字段，避免为了测一个字段起整套服务 */
function fakeContext(options: {
  path: string;
  patientId: string;
  captured: { body?: unknown };
}): H5RouteContext {
  return {
    method: 'GET',
    path: options.path,
    query: new URLSearchParams(),
    requestId: 'req_test',
    service: { consentStatus: () => 'granted' } as never,
    readJson: async () => ({}),
    readRawBody: async () => Buffer.alloc(0),
    requireSession: async () =>
      ({
        session: { id: 'phs_test', patientId: options.patientId },
        patient: { id: options.patientId, status: 'serving', displayName: '测试患者（虚构）' },
      }) as never,
    checkOrigin: () => undefined,
    ok: (_status, body) => {
      options.captured.body = body;
    },
    fail: (error) => {
      throw error;
    },
  };
}

const FAKE_TODAY = {
  date: '2026-11-26',
  nextItem: null,
  items: [],
  progress: { done: 0, missed: 0, needsHelp: 0, pending: 0, total: 0 },
  quickRecord: { meal: true, review: true },
  allDone: false,
};

function routesWithCompanion(days: () => number | null) {
  return createCalendarRoutes({
    calendar: { today: () => FAKE_TODAY } as never,
    companionDays: days,
  });
}

test('/today 带出陪伴天数，前端不再显示破折号', async () => {
  const captured: { body?: unknown } = {};
  const [todayRoute] = routesWithCompanion(() => 16);
  await todayRoute!({} as never, {} as never, fakeContext({ path: '/today', patientId: 'pat_a', captured }));
  const body = captured.body as { companionDays?: number };
  assert.equal(body.companionDays, 16);
});

test('没有服务开始时间时返回 null，而不是 0（0 会被显示成「第 0 天」）', async () => {
  const captured: { body?: unknown } = {};
  const [todayRoute] = routesWithCompanion(() => null);
  await todayRoute!({} as never, {} as never, fakeContext({ path: '/today', patientId: 'pat_a', captured }));
  const body = captured.body as { companionDays?: number | null };
  assert.equal(body.companionDays, null);
});

test('未注入陪伴天数时也返回 null（插件装配缺省不影响其它路由）', async () => {
  const captured: { body?: unknown } = {};
  const [todayRoute] = createCalendarRoutes({ calendar: { today: () => FAKE_TODAY } as never });
  await todayRoute!({} as never, {} as never, fakeContext({ path: '/today', patientId: 'pat_a', captured }));
  const body = captured.body as { companionDays?: number | null };
  assert.equal(body.companionDays, null);
});
