import { beforeEach, describe, expect, it } from 'vitest';

import { resetAdvisorsMock } from '../src/mock/advisors.ts';
import {
  getAlertDetail,
  listAlerts,
  releaseQueue,
  resetAlertsMock,
  resolveAlert,
  restoreAdvisor,
  unresolvedCount,
} from '../src/mock/alerts.ts';
import { listMealLogs } from '../src/mock/meal-logs.ts';
import {
  applySandboxAction,
  createSandboxSession,
  getSandboxState,
  resetSandboxMock,
  sendSandboxMessage,
  type SandboxAction,
  type VerificationOutcome,
} from '../src/mock/sandbox.ts';
import {
  emitNextFlowEvent,
  getServiceFlowDetail,
  listServiceFlow,
  resetServiceFlowMock,
} from '../src/mock/service-flow.ts';
import { diffSegments } from '../src/pages/service-flow/diff.ts';

beforeEach(() => {
  resetServiceFlowMock();
  resetAlertsMock();
  resetSandboxMock();
  resetAdvisorsMock();
});

describe('WP-J mock：实时服务流', () => {
  it('列表按状态过滤，详情带时间线、实发与核验', async () => {
    const all = await listServiceFlow({ pageSize: 50 });
    expect(all.items.length).toBeGreaterThanOrEqual(8);

    const verified = await listServiceFlow({ status: 'VERIFIED', pageSize: 50 });
    expect(verified.items.length).toBeGreaterThan(0);
    expect(verified.items.every((item) => item.status === 'VERIFIED')).toBe(true);

    const detail = await getServiceFlowDetail('draft_1015');
    expect(detail.draft.id).toBe('draft_1015');
    expect(detail.verification?.outcome).toBe('verified');
    expect(detail.deliveries.length).toBeGreaterThan(0);
    expect(detail.timeline.length).toBeGreaterThan(0);

    const skipped = await getServiceFlowDetail('draft_1016');
    expect(skipped.draft.status).toBe('SKIPPED');
    expect(skipped.draft.body).toBe('');
  });

  it('mock 事件按 created → pushed → acked → verified 推进，然后开下一条', () => {
    const first = emitNextFlowEvent();
    expect(first.event.type).toBe('draft.created');
    expect(first.row?.status).toBe('QUEUED');

    const second = emitNextFlowEvent();
    expect(second.event.type).toBe('draft.pushed');
    expect(second.row?.status).toBe('PUSHED');

    const third = emitNextFlowEvent();
    expect(third.event.type).toBe('draft.acked');
    expect(third.row?.status).toBe('ACKNOWLEDGED');

    const fourth = emitNextFlowEvent();
    expect(fourth.event.type).toBe('draft.verified');
    expect(fourth.row?.status).toBe('VERIFIED');

    const fifth = emitNextFlowEvent();
    expect(fifth.event.type).toBe('draft.created');
    expect(fifth.row?.id).not.toBe(first.row?.id);
  });
});

describe('WP-J mock：质检与告警', () => {
  it('未处理数、必填备注、重复处理与详情', async () => {
    expect(await unresolvedCount()).toEqual({ open: 4, acknowledged: 1, total: 5 });

    await expect(resolveAlert('alt_01', '   ')).rejects.toThrow('处理备注不能为空');
    const resolved = await resolveAlert('alt_01', '已电话确认顾问补发');
    expect(resolved.status).toBe('resolved');
    expect(resolved.note).toBe('已电话确认顾问补发');
    await expect(resolveAlert('alt_01', '再处理一次')).rejects.toThrow('该告警已处理');

    const remaining = await unresolvedCount();
    expect(remaining).toEqual({ open: 3, acknowledged: 1, total: 4 });

    const misroute = await listAlerts({ kind: 'misroute' });
    expect(misroute.items.map((item) => item.id)).toEqual(['alt_02']);

    const detail = await getAlertDetail('alt_02');
    expect(detail.patient?.displayName).toBe('孙女士');
    expect(detail.draft?.id).toBe('draft_1007');
  });

  it('释放队列与恢复顾问会更新关联对象', async () => {
    const released = await releaseQueue('alt_05');
    expect(released.releasedDraftId).toBe('draft_1009');
    expect(released.nextDraftId).toBe('draft_1011');
    expect(released.alert.status).toBe('acknowledged');

    const restored = await restoreAdvisor('alt_03');
    expect(restored.advisorId).toBe('adv_03');
    expect(restored.alert.status).toBe('resolved');
  });
});

describe('WP-J mock：体验沙盒', () => {
  it('过敏消息写记忆，晚餐草稿避开海鲜', async () => {
    await createSandboxSession();
    await sendSandboxMessage({ kind: 'text', text: '我对海鲜过敏' });

    let state = await getSandboxState();
    expect(state.memories.map((item) => item.content)).toContain('对海鲜过敏');
    expect(state.drafts).toHaveLength(0);

    await sendSandboxMessage({ kind: 'text', text: '晚上吃什么好' });
    state = await getSandboxState();
    const draft = state.drafts.at(-1);
    expect(draft?.body).toContain('避开海鲜');
  });

  it('四种操作分别产出四种核验结果', async () => {
    const cases: {
      action: SandboxAction;
      expected: VerificationOutcome;
      options?: { editedBody?: string; targetGroupId?: string };
    }[] = [
      { action: 'send_original', expected: 'verified' },
      { action: 'send_edited', expected: 'edit_sent', options: { editedBody: '顾问改写后的回复' } },
      {
        action: 'send_wrong_group',
        expected: 'misroute',
        options: { targetGroupId: 'grp_sandbox_2' },
      },
      { action: 'ack_only', expected: 'unverified' },
    ];

    for (const item of cases) {
      resetSandboxMock();
      await createSandboxSession();
      await sendSandboxMessage({ kind: 'image', mediaId: 'med_sample_meal_01' });
      const state = await getSandboxState();
      const draft = state.drafts.at(-1);
      expect(draft).toBeTruthy();

      const result = await applySandboxAction(draft!.id, item.action, item.options);
      expect(result.outcome).toBe(item.expected);
    }

    resetSandboxMock();
    await createSandboxSession();
    await sendSandboxMessage({ kind: 'text', text: '晚上吃什么好' });
    const state = await getSandboxState();
    const result = await applySandboxAction(state.drafts[0].id, 'send_wrong_group', {
      targetGroupId: 'grp_sandbox_2',
    });
    expect(result.verification.matchedGroupName).toBe('另一个客户群');
  });
});

describe('WP-J mock：饮食记录与 diff', () => {
  it('饮食记录返回虚构餐食与内联图片', async () => {
    const logs = await listMealLogs('pat_01');
    expect(logs).toHaveLength(1);
    expect(logs[0].mealType).toBe('dinner');
    expect(logs[0].foods.map((food) => food.name)).toContain('清蒸鲈鱼');
    expect(logs[0].photoUrl.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('diff 标出相同、删除与新增片段', () => {
    expect(diffSegments('晚上吃鱼', '晚上吃鸡')).toEqual([
      { type: 'same', text: '晚上吃' },
      { type: 'removed', text: '鱼' },
      { type: 'added', text: '鸡' },
    ]);
    expect(diffSegments('同一句话', '同一句话')).toEqual([
      { type: 'same', text: '同一句话' },
    ]);
  });
});
