/**
 * #147 侧边栏视图：权限、昵称门控与未接入状态。
 * 全部虚构数据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PendingItem } from '../src/p1/sidebar.ts';
import type { ChronicProfile } from '../src/p1/chronic.ts';
import {
  SidebarAccessError,
  buildSidebarContext,
} from '../src/p1/sidebar-view.ts';
import type { SidebarViewDeps } from '../src/p1/sidebar-view.ts';

const NOW = 1_700_000_000_000;
const ROOM = 'room_1';

function item(overrides: Partial<PendingItem> = {}): PendingItem {
  return {
    id: 'pend_1',
    convKey: `room:${ROOM}`,
    kind: 'group',
    roomId: ROOM,
    customerId: 'wm_a',
    firstAt: NOW - 2 * 60 * 60_000,
    lastAt: NOW - 2 * 60 * 60_000,
    messageCount: 2,
    excerpt: '明天几点复诊？',
    reason: 'question',
    status: 'open',
    ...overrides,
  };
}

function deps(overrides: Partial<SidebarViewDeps> = {}): SidebarViewDeps {
  return {
    openItems: () => [item()],
    recentlyClosed: () => [],
    lastObservedAt: () => NOW - 1000,
    listGroups: () => [
      { roomId: ROOM, chatId: 'chat_1', name: '高血压管理 1 群', advisorId: 'adv_1' },
    ],
    patientIdsForRoom: () => ['pat_1'],
    getPatient: () => ({
      id: 'pat_1',
      displayName: '王阿姨',
      tags: ['高血压'],
      consent: 'agreed',
      identityStatus: 'confirmed',
      lastActiveAt: NOW - 3 * 24 * 60 * 60_000,
      advisorId: 'adv_1',
      accompaniedSince: NOW - 30 * 24 * 60 * 60_000,
    }),
    groupsForPatient: () => ['高血压管理 1 群', '复诊跟进群'],
    patientNameFor: (id) => (id === 'wm_a' ? '王阿姨' : undefined),
    getAdvisorName: () => '李医生',
    now: () => NOW,
    ...overrides,
  };
}

const ADVISOR = { id: 'adv_1', permissions: ['patient.read'] };

test('绑定顾问能拿到待回复、原文和速览', () => {
  const view = buildSidebarContext(deps(), ADVISOR, { chatId: 'chat_1' });
  assert.equal(view.conv.served, true);
  assert.equal(view.conv.name, '高血压管理 1 群');
  assert.equal(view.pending.openCount, 1);
  assert.equal(view.pending.open[0]!.customerName, '王阿姨');
  assert.equal(view.pending.open[0]!.excerpt, '明天几点复诊？');
  assert.equal(view.pending.open[0]!.waitSeconds, 7200);
  assert.equal(view.pending.oldestWaitSeconds, 7200);
  assert.equal(view.profile?.bound, true);
  assert.equal(view.profile?.name, '王阿姨');
  assert.equal(view.profile?.silentDays, 3);
  assert.equal(view.profile?.advisorName, '李医生');
  // 速览固定字段：前端据此渲染固定区块
  assert.equal(view.profile?.consent, 'agreed');
  assert.equal(view.profile?.servedDays, 30);
  assert.deepEqual(view.profile?.groups, ['高血压管理 1 群', '复诊跟进群']);
});

test('速览结构稳定：没有标签、没有慢病档案时字段依然齐全', () => {
  // 真机反馈：档案信息少时卡片只剩一行，看起来像坏了。
  // 视图层固定返回这些字段，由前端渲染「未打标签 / 尚未录入」占位。
  const view = buildSidebarContext(
    deps({
      openItems: () => [],
      getPatient: () => ({
        id: 'pat_2',
        displayName: 'Star',
        tags: [],
        consent: 'unknown',
        identityStatus: 'confirmed',
        lastActiveAt: NOW,
        accompaniedSince: NOW - 7 * 24 * 60 * 60_000,
      }),
      groupsForPatient: () => [],
    }),
    ADVISOR,
    { chatId: 'chat_1' },
  );
  const profile = view.profile;
  assert.ok(profile);
  assert.equal(profile.bound, true);
  assert.equal(profile.name, 'Star');
  assert.deepEqual(profile.tags, []);
  assert.equal(profile.consent, 'unknown');
  assert.equal(profile.servedDays, 7);
  assert.deepEqual(profile.groups, []);
  assert.equal(profile.chronic, null);
  assert.equal(profile.silentDays, 0);
});

test('没有 patient.read 时昵称、群名与标签都不返回', () => {
  const view = buildSidebarContext(deps(), { id: 'adv_1', permissions: [] }, { chatId: 'chat_1' });
  assert.equal(view.conv.name, null);
  assert.equal(view.pending.open[0]!.customerName, null);
  assert.equal(view.profile?.name, null);
  assert.deepEqual(view.profile?.tags, []);
  assert.equal(view.profile?.advisorName, null);
  // 客户数据全部收口：存档状态、服务天数、服务群也不返回
  assert.equal(view.profile?.consent, null);
  assert.equal(view.profile?.servedDays, null);
  assert.deepEqual(view.profile?.groups, []);
  assert.equal(view.profile?.silentDays, null);
  // 待回复本身仍然可见：顾问就在这个会话里
  assert.equal(view.pending.openCount, 1);
});

test('非绑定顾问一律 403，不返回任何客户字段', () => {
  assert.throws(
    () => buildSidebarContext(deps(), { id: 'adv_2', permissions: ['patient.read'] }, { chatId: 'chat_1' }),
    (error: unknown) =>
      error instanceof SidebarAccessError && error.code === 'FORBIDDEN',
  );
});

test('未登录/令牌失效按 401 处理', () => {
  assert.throws(
    () => buildSidebarContext(deps(), undefined, { chatId: 'chat_1' }),
    (error: unknown) =>
      error instanceof SidebarAccessError && error.code === 'UNAUTHENTICATED',
  );
});

test('群不存在返回 served=false，不抛异常', () => {
  const view = buildSidebarContext(deps(), ADVISOR, { chatId: 'chat_unknown' });
  assert.equal(view.conv.served, false);
  assert.equal(view.conv.reason, 'GROUP_NOT_FOUND');
  assert.equal(view.pending.openCount, 0);
  assert.equal(view.profile, null);
});

test('#150 企微客户群 roomId 与 chatId 同值：拿 chatId 能匹配只有 roomId 的档案', () => {
  // 现网实况：档案按存档 roomId 绑定，chatId 字段留空，侧边栏却拿 JS-SDK 的
  // chatId 查询，严格等值匹配会误报「群未接入」。两个键都参与匹配。
  const view = buildSidebarContext(
    deps({
      listGroups: () => [{ roomId: 'wr_room_1', name: '客户_wb001', advisorId: 'adv_1' }],
      openItems: () => [],
    }),
    ADVISOR,
    { chatId: 'wr_room_1' },
  );
  assert.equal(view.conv.served, true);
  assert.equal(view.conv.name, '客户_wb001');
});

test('#150 反向同理：拿 roomId 查询能匹配只有 chatId 的档案', () => {
  const view = buildSidebarContext(
    deps({
      listGroups: () => [{ roomId: 'wr_room_2', chatId: 'wr_chat_2', name: '客户_wb002', advisorId: 'adv_1' }],
      openItems: () => [],
    }),
    ADVISOR,
    { roomId: 'wr_chat_2' },
  );
  assert.equal(view.conv.served, true);
});

test('#159 顾问自己的客户单聊返回待回复与速览', () => {
  const advisor = { id: 'adv_1', wecomUserId: 'LiGuang', permissions: ['patient.read'] };
  const view = buildSidebarContext(
    deps({
      openItems: () => [
        item({
          convKey: 'dm:LiGuang:wm_star',
          kind: 'dm',
          roomId: undefined,
          customerId: 'wm_star',
          excerpt: '化学为什么老学不明白？',
        }),
      ],
      patientNameFor: (id) => (id === 'wm_star' ? '汪星' : undefined),
      patientForExternal: (id) =>
        id === 'wm_star'
          ? {
              id: 'pat_star',
              displayName: '汪星',
              tags: ['化学'],
              consent: 'agreed',
              identityStatus: 'confirmed',
              lastActiveAt: NOW - 2 * 60 * 60_000,
              advisorId: 'adv_1',
              accompaniedSince: NOW - 3 * 24 * 60 * 60_000,
            }
          : undefined,
      groupsForPatient: () => ['客户-汪星-20261108'],
      getPatient: () => undefined,
    }),
    advisor,
    { externalUserId: 'wm_star' },
  );
  assert.equal(view.conv.kind, 'dm');
  assert.equal(view.conv.served, true);
  assert.equal(view.conv.key, 'dm:LiGuang:wm_star');
  assert.equal(view.conv.name, '汪星');
  assert.equal(view.pending.openCount, 1);
  assert.equal(view.pending.open[0]!.customerName, '汪星');
  assert.equal(view.pending.open[0]!.excerpt, '化学为什么老学不明白？');
  assert.equal(view.pending.open[0]!.hasDraft, false);
  assert.equal(view.pending.open[0]!.draft, null);
  assert.equal(view.profile?.bound, true);
  assert.equal(view.profile?.name, '汪星');
  assert.equal(view.profile?.confirmed, true);
  assert.equal(view.profile?.advisorName, '李医生');
  assert.equal(view.profile?.consent, 'agreed');
  assert.equal(view.profile?.servedDays, 3);
  assert.deepEqual(view.profile?.groups, ['客户-汪星-20261108']);
});

test('#159 没有 patient.read 时单聊昵称与速览为空，条目仍可见', () => {
  const advisor = { id: 'adv_1', wecomUserId: 'LiGuang', permissions: [] };
  const view = buildSidebarContext(
    deps({
      openItems: () => [
        item({ convKey: 'dm:LiGuang:wm_star', kind: 'dm', roomId: undefined, customerId: 'wm_star' }),
      ],
      patientNameFor: () => '汪星',
      patientForExternal: () => ({
        id: 'pat_star',
        displayName: '汪星',
        tags: [],
        consent: 'agreed',
      }),
      getPatient: () => undefined,
    }),
    advisor,
    { externalUserId: 'wm_star' },
  );
  assert.equal(view.conv.served, true);
  assert.equal(view.conv.name, null);
  assert.equal(view.pending.openCount, 1);
  assert.equal(view.pending.open[0]!.customerName, null);
  assert.equal(view.profile?.bound, true);
  assert.equal(view.profile?.name, null);
  assert.equal(view.profile?.advisorName, null);
  assert.equal(view.profile?.consent, null);
  assert.equal(view.profile?.servedDays, null);
  assert.deepEqual(view.profile?.groups, []);
});

test('#159 单聊会话键只按登录顾问自己的 userid 构造，换人查不到', () => {
  const view = buildSidebarContext(
    deps({
      openItems: () => [],
    }),
    { id: 'adv_1', wecomUserId: 'OtherStaff', permissions: ['patient.read'] },
    { externalUserId: 'wm_star' },
  );
  // 其他员工的单聊键没有条目，速览也未绑定——但会话本身照常返回
  assert.equal(view.conv.served, true);
  assert.equal(view.conv.key, 'dm:OtherStaff:wm_star');
  assert.equal(view.pending.openCount, 0);
});

test('#159 顾问没有企微 userid 时单聊按未接入返回', () => {
  const view = buildSidebarContext(
    deps(),
    { id: 'adv_1', permissions: ['patient.read'] },
    { externalUserId: 'wm_star' },
  );
  assert.equal(view.conv.served, false);
  assert.equal(view.conv.reason, 'DM_NOT_SUPPORTED');
});

test('群未绑定患者时速览为 bound=false，待回复仍可见', () => {
  const view = buildSidebarContext(
    deps({ patientIdsForRoom: () => [] }),
    ADVISOR,
    { chatId: 'chat_1' },
  );
  assert.equal(view.profile?.bound, false);
  assert.equal(view.pending.openCount, 1);
});

test('机器人已回应只做标记，不计入关闭', () => {
  const view = buildSidebarContext(
    deps({ openItems: () => [item({ botRepliedAt: NOW - 60_000 })] }),
    ADVISOR,
    { chatId: 'chat_1' },
  );
  assert.equal(view.pending.open[0]!.aiReplied, true);
  assert.equal(view.pending.openCount, 1);
});

test('#149 草稿只挂在最新一条上，旧条目不再重复展示', () => {
  const older = item({ id: 'pend_old', lastAt: NOW - 30 * 60_000, firstAt: NOW - 30 * 60_000 });
  const newer = item({ id: 'pend_new', lastAt: NOW - 60_000, firstAt: NOW - 60_000 });
  const seen: Array<{ roomId: string; since: number }> = [];
  const view = buildSidebarContext(
    deps({
      openItems: () => [older, newer],
      latestDraft: (roomId, since) => {
        seen.push({ roomId, since });
        return {
          id: 'draft_1',
          body: '先别停药，今天下午来门诊看一下。',
          riskLevel: 'medium',
          ruleNames: ['用药安全'],
          createdAt: NOW - 30_000,
          status: 'PUSHED',
        };
      },
    }),
    ADVISOR,
    { chatId: 'chat_1' },
  );

  assert.deepEqual(seen, [{ roomId: ROOM, since: newer.firstAt }]);
  const old = view.pending.open.find((row) => row.id === 'pend_old')!;
  const fresh = view.pending.open.find((row) => row.id === 'pend_new')!;
  assert.equal(old.hasDraft, false);
  assert.equal(old.draft, null);
  assert.equal(fresh.hasDraft, true);
  assert.equal(fresh.draft?.id, 'draft_1');
  assert.deepEqual(fresh.draft?.ruleNames, ['用药安全']);
});

test('#149 没有草稿或未接入草稿源时字段为空，不假装有草稿', () => {
  const none = buildSidebarContext(deps(), ADVISOR, { chatId: 'chat_1' });
  assert.equal(none.pending.open[0]!.hasDraft, false);
  assert.equal(none.pending.open[0]!.draft, null);

  const empty = buildSidebarContext(
    deps({ latestDraft: () => undefined }),
    ADVISOR,
    { chatId: 'chat_1' },
  );
  assert.equal(empty.pending.open[0]!.draft, null);
});

const DAY = 24 * 60 * 60_000;

function chronicProfile(overrides: Partial<ChronicProfile> = {}): ChronicProfile {
  return {
    patientId: 'pat_1',
    tenantId: 'tenant_demo',
    conditions: ['高血压', '2 型糖尿病'],
    medications: [
      { name: '氨氯地平', dose: '5mg', frequency: '每日一次', source: 'advisor', updatedAt: NOW },
      { name: '二甲双胍', dose: '0.5g', frequency: '每日两次', source: 'agent', updatedAt: NOW },
      { name: '阿托伐他汀', source: 'advisor', updatedAt: NOW },
      { name: '阿司匹林', source: 'advisor', updatedAt: NOW },
    ],
    measurements: [
      // 最新在前；同一指标多条时只取最先出现的一条
      { id: 'm_bp_new', metric: 'bp', value: 138, secondaryValue: 86, measuredAt: NOW - 2 * DAY, source: 'advisor', recordedAt: NOW - 2 * DAY },
      { id: 'm_weight', metric: 'weight', value: 68, measuredAt: NOW - DAY, source: 'agent', recordedAt: NOW - DAY },
      { id: 'm_bp_old', metric: 'bp', value: 145, secondaryValue: 92, measuredAt: NOW - 10 * DAY, source: 'advisor', recordedAt: NOW - 10 * DAY },
      { id: 'm_hr', metric: 'heart_rate', value: 76, measuredAt: NOW - 3 * DAY, source: 'advisor', recordedAt: NOW - 3 * DAY },
      { id: 'm_glucose', metric: 'glucose', value: 7.2, context: '空腹', measuredAt: NOW - 5 * DAY, source: 'agent', recordedAt: NOW - 5 * DAY },
      { id: 'm_hba1c', metric: 'hba1c', value: 6.8, measuredAt: NOW - 20 * DAY, source: 'advisor', recordedAt: NOW - 20 * DAY },
    ],
    updatedAt: NOW - DAY,
    ...overrides,
  };
}

test('#144 速览带慢病档案：每指标取最新，最多 3 项，按测量时间倒序', () => {
  const view = buildSidebarContext(
    deps({ getChronic: () => chronicProfile() }),
    ADVISOR,
    { chatId: 'chat_1' },
  );
  const chronic = view.profile?.chronic;
  assert.ok(chronic);
  assert.deepEqual(chronic.conditions, ['高血压', '2 型糖尿病']);
  assert.equal(chronic.updatedAt, NOW - DAY);

  // weight(1 天) → bp(2 天) → heart_rate(3 天)；血糖、糖化更早，被截断
  assert.deepEqual(chronic.measurements.map((row) => row.metric), ['weight', 'bp', 'heart_rate']);
  const bp = chronic.measurements[1]!;
  assert.equal(bp.label, '血压');
  assert.equal(bp.value, 138);
  assert.equal(bp.secondaryValue, 86);
  assert.equal(bp.unit, 'mmHg');
  assert.equal(bp.measuredAt, NOW - 2 * DAY);
  assert.equal(bp.source, 'advisor');
  assert.equal(chronic.measurements[0]!.secondaryValue, null);

  // 用药最多 3 条，剂量/频次缺失时为 null
  assert.equal(chronic.medications.length, 3);
  assert.deepEqual(chronic.medications[0], { name: '氨氯地平', dose: '5mg', frequency: '每日一次' });
  assert.deepEqual(chronic.medications[2], { name: '阿托伐他汀', dose: null, frequency: null });
});

test('#144 没有慢病档案或档案为空时为 null，不返回空壳', () => {
  const none = buildSidebarContext(deps(), ADVISOR, { chatId: 'chat_1' });
  assert.equal(none.profile?.chronic, null);

  const empty = buildSidebarContext(
    deps({
      getChronic: () => ({
        patientId: 'pat_1',
        tenantId: 'tenant_demo',
        conditions: [],
        medications: [],
        measurements: [],
        updatedAt: 0,
      }),
    }),
    ADVISOR,
    { chatId: 'chat_1' },
  );
  assert.equal(empty.profile?.chronic, null);
});

test('#144 没有 patient.read 时不读取也不返回慢病档案', () => {
  let called = 0;
  const view = buildSidebarContext(
    deps({
      getChronic: () => {
        called += 1;
        return chronicProfile();
      },
    }),
    { id: 'adv_1', permissions: [] },
    { chatId: 'chat_1' },
  );
  assert.equal(view.profile?.bound, true);
  assert.equal(view.profile?.chronic, null);
  assert.equal(called, 0);
});
