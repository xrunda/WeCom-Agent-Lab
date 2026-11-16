/**
 * 顾问 1:1 的「我的待办」命令（#167）：命令表已收窄，我的草稿退役为 Agent 工具。
 * 输出与 advisor_overview 工具共用 format.ts。全部虚构数据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdvisorStatusService, isAdvisorStatusCommand } from '../plugins/zhiban-wecom/advisor-status.ts';
import type { AdvisorStatusDeps } from '../plugins/zhiban-wecom/advisor-status.ts';

const NOW = Date.UTC(2026, 10, 14, 2); // 10:00 CST

function service(overrides: Partial<AdvisorStatusDeps> = {}) {
  return new AdvisorStatusService({
    drafts: () => [
      {
        id: 'draft_1',
        groupName: '高血压管理 1 群',
        riskLevel: 'medium',
        status: 'PUSHED',
        since: NOW - 2 * 60 * 60_000,
        version: 2,
      },
      {
        id: 'draft_2',
        groupName: '已确认的群',
        riskLevel: 'low',
        status: 'VERIFIED',
        since: NOW - 3 * 60 * 60_000,
      },
    ],
    promises: () => [
      { groupName: '高血压管理 1 群', dueAt: NOW + 3 * 60 * 60_000, dueLabel: '今天 18:00' },
      { groupName: '下周的群', dueAt: NOW + 7 * 24 * 60 * 60_000, dueLabel: '11-21 18:00' },
    ],
    alerts: () => [{ id: 'alert_1', title: '员工发言命中红线', at: NOW - 5 * 60_000 }],
    now: () => NOW,
    ...overrides,
  });
}

test('指令识别：只认待办，我的草稿已退役，其他文本不接管', () => {
  assert.equal(isAdvisorStatusCommand('待办'), 'todo');
  assert.equal(isAdvisorStatusCommand('今天待办'), 'todo');
  assert.equal(isAdvisorStatusCommand('我的待办'), 'todo');
  assert.equal(isAdvisorStatusCommand('我的草稿'), undefined);
  assert.equal(isAdvisorStatusCommand('草稿'), undefined);
  assert.equal(isAdvisorStatusCommand('帮我改一下草稿'), undefined);
  assert.equal(isAdvisorStatusCommand('为什么红线'), undefined);
});

test('我的待办汇总草稿、今日到期承诺与未处理告警', () => {
  const text = service().reply('adv_1', '今天待办') ?? '';
  assert.match(text, /待处理草稿 1 条（最久 2 小时）/);
  assert.match(text, /今日到期承诺 1 条（最近 今天 18:00）/);
  assert.match(text, /未处理告警 1 条（最近：员工发言命中红线）/);
  // 下周到期的承诺不算今日
  assert.equal(text.includes('11-21'), false);
});

test('待回复会话数只在数据源可用时出现', () => {
  const withPending = service({ pendingReplies: () => 2 }).reply('adv_1', '我的待办') ?? '';
  assert.match(withPending, /待回复会话 2 个/);
  const withoutPending = service().reply('adv_1', '我的待办') ?? '';
  assert.equal(withoutPending.includes('待回复会话'), false);
});

test('什么都没有时如实说没有待办', () => {
  const text = service({ drafts: () => [], promises: () => [], alerts: () => [] }).reply('adv_1', '我的待办') ?? '';
  assert.match(text, /现在没有待办/);
});

test('不是指令时返回 undefined，交给 Agent / 改稿流程', () => {
  assert.equal(service().reply('adv_1', '语气再温和一点'), undefined);
  assert.equal(service().reply('adv_1', '汪女士最近血糖怎么样'), undefined);
});
