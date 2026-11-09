import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTimeline,
  cancelCarePlan,
  createCarePlan,
  deleteMemory,
  getHealthProfile,
  getPatientDetail,
  getServicePlan,
  listCarePlans,
  listMemories,
  listPatients,
  resetPatientsMock,
  updateMemory,
} from '../src/mock/patients.ts';

beforeEach(() => {
  resetPatientsMock();
});

describe('患者 mock 数据', () => {
  it('按关键字、标签和状态筛选', async () => {
    expect((await listPatients({ q: '张' })).items.map((item) => item.id)).toEqual(['pat_01']);
    expect((await listPatients({ tag: '减重' })).items.map((item) => item.id)).toEqual(['pat_02']);
    expect(await listPatients({ q: '不存在的名字' })).toMatchObject({ total: 0 });
  });

  it('详情包含顾问与绑定群', async () => {
    const detail = await getPatientDetail('pat_01');
    expect(detail.advisor?.name).toBe('李顾问');
    expect(detail.groups).toHaveLength(1);
    expect(detail.groups[0]).toMatchObject({ name: '糖友-张女士', isPrimary: true });
  });

  it('记忆可编辑、可删除，删除后计数同步', async () => {
    const before = (await listPatients({ q: '张' })).items[0];
    expect(before.memoryCount).toBe(3);

    const updated = await updateMemory('mem_01', { content: '对虾蟹过敏' });
    expect(updated.content).toBe('对虾蟹过敏');

    await expect(updateMemory('mem_01', { content: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await deleteMemory('mem_01');
    const remaining = await listMemories('pat_01');
    expect(remaining.every((item) => item.id !== 'mem_01')).toBe(true);

    const after = (await listPatients({ q: '张' })).items[0];
    expect(after.memoryCount).toBe(2);
  });

  it('计划可新建、可取消，已完成计划不可取消', async () => {
    const when = Date.now() + 3_600_000;
    const created = await createCarePlan('pat_01', { title: '提醒喝水', when });
    expect(created).toMatchObject({ title: '提醒喝水', status: 'pending', source: 'staff' });

    const pending = await listCarePlans('pat_01', 'pending');
    expect(pending.some((item) => item.id === created.id)).toBe(true);

    const cancelled = await cancelCarePlan(created.id);
    expect(cancelled.status).toBe('cancelled');

    await expect(cancelCarePlan('pln_04')).rejects.toMatchObject({
      code: 'IMMUTABLE_RESOURCE',
    });
    await expect(
      createCarePlan('pat_01', { title: '过去的时间', when: Date.now() - 1000 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('时间线按时间递增，包含客户消息、草稿、发送与核验', () => {
    const events = buildTimeline('pat_01');
    expect(events.length).toBeGreaterThan(0);
    const timestamps = events.map((item) => item.at);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);

    const types = new Set(events.map((item) => item.type));
    expect(types.has('inbound')).toBe(true);
    expect(types.has('draft')).toBe(true);
    expect(types.has('delivery')).toBe(true);
    expect(types.has('verification')).toBe(true);
  });

  it('健康档案与服务计划带 sample 标记', async () => {
    const profile = await getHealthProfile('pat_01');
    expect(profile.sample).toBe(true);
    expect(profile.bmi).toBeGreaterThan(0);

    const plan = await getServicePlan('pat_01');
    expect(plan.sample).toBe(true);
    expect(plan.goals.length).toBeGreaterThan(0);
  });
});
