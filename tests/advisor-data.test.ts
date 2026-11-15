/**
 * `zhibanAdvisorData` 只读端口装配（#167 §3.1）：范围过滤、昵称权限、发送目标。
 * 全部虚构数据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAdvisorWecomData, pendingRepliesFromSidebar } from '../plugins/zhiban-wecom/advisor-data.ts';
import type { AdvisorWecomDataDeps } from '../plugins/zhiban-wecom/advisor-data.ts';
import { makeDraft } from './helpers.ts';

function deps(overrides: Partial<AdvisorWecomDataDeps> = {}): AdvisorWecomDataDeps {
  const drafts = [
    makeDraft({ id: 'd1', advisorId: 'adv_1', groupName: '群 1', riskLevel: 'medium', status: 'PUSHED', pushedAt: 1000 }),
    makeDraft({ id: 'd2', advisorId: 'adv_2', groupName: '群 2', riskLevel: 'low', status: 'PUSHED', pushedAt: 2000 }),
  ];
  return {
    listDrafts: () => drafts,
    listPromises: () => [],
    listGroups: () => [{ roomId: 'room_1', advisorId: 'adv_1' }],
    getAdvisor: (id) => (id === 'adv_1' ? { name: '王顾问', chatId: 'wang.guwen' } : undefined),
    getActiveDraft: (advisorId) => (advisorId === 'adv_1' ? 'd1' : undefined),
    getDraft: (id) => drafts.find((draft) => draft.id === id),
    openAlerts: () => [],
    openPendingCount: () => undefined,
    sendText: async () => {},
    canReadPatient: true,
    ...overrides,
  };
}

test('草稿按顾问过滤，只返回本人名下的未完成草稿', () => {
  const data = buildAdvisorWecomData(deps());
  const drafts = data.draftsFor('adv_1');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.id, 'd1');
  assert.equal(data.draftsFor('adv_2')[0]!.id, 'd2');
});

test('活动草稿：只返回该顾问的当前活动草稿', () => {
  const data = buildAdvisorWecomData(deps());
  const active = data.activeDraftFor('adv_1');
  assert.equal(active?.id, 'd1');
  assert.equal(data.activeDraftFor('adv_2'), undefined);
});

test('发送：chatId 优先取顾问记录，其次回退 advisorId', async () => {
  const calls: Array<{ chatId: string; text: string }> = [];
  const data = buildAdvisorWecomData(deps({ sendText: async (chatId, text) => void calls.push({ chatId, text }) }));
  assert.equal(await data.sendText('adv_1', '你好'), true);
  assert.equal(calls[0]!.chatId, 'wang.guwen');
  assert.equal(await data.sendText('adv_3', '你好'), true);
  assert.equal(calls[1]!.chatId, 'adv_3');
});

test('发送失败时返回 false，不向上抛', async () => {
  const data = buildAdvisorWecomData(deps({ sendText: async () => { throw new Error('BOT_DOWN'); } }));
  assert.equal(await data.sendText('adv_1', '你好'), false);
});

test('待回复计数：匹配服务群与顾问 1:1 的 open 条目', () => {
  const count = pendingRepliesFromSidebar({
    advisorId: 'wang.guwen',
    groupRoomIds: new Set(['room_1']),
    allItems: () => [
      { convKey: 'room:room_1', status: 'open' },
      { convKey: 'room:room_1', status: 'closed' },
      { convKey: 'dm:wang.guwen:wm_abc', status: 'open' },
      { convKey: 'dm:other.staff:wm_abc', status: 'open' },
    ],
  });
  assert.equal(count, 2);
});
