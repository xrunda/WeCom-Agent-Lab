/**
 * #147 侧边栏视图：权限、昵称门控与未接入状态。
 * 全部虚构数据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PendingItem } from '../src/p1/sidebar.ts';
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
    }),
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
});

test('没有 patient.read 时昵称、群名与标签都不返回', () => {
  const view = buildSidebarContext(deps(), { id: 'adv_1', permissions: [] }, { chatId: 'chat_1' });
  assert.equal(view.conv.name, null);
  assert.equal(view.pending.open[0]!.customerName, null);
  assert.equal(view.profile?.name, null);
  assert.deepEqual(view.profile?.tags, []);
  assert.equal(view.profile?.advisorName, null);
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

test('单聊在当前存档链路下明确返回未接入', () => {
  const view = buildSidebarContext(deps(), ADVISOR, { externalUserId: 'wm_a' });
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
