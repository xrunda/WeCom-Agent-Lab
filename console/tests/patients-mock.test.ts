import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTimeline,
  cancelCarePlan,
  createCarePlan,
  deleteMemory,
  getChronicProfile,
  getPatientDetail,
  updateChronicProfile,
  getServicePlan,
  getTimeline,
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

  it('时间线按时间倒序，包含客户消息、草稿、发送与核验', async () => {
    const events = buildTimeline('pat_01');
    expect(events.length).toBeGreaterThan(0);
    const timestamps = events.map((item) => item.at);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

    const types = new Set(events.map((item) => item.type));
    expect(types.has('inbound')).toBe(true);
    expect(types.has('draft')).toBe(true);
    expect(types.has('delivery')).toBe(true);
    expect(types.has('verification')).toBe(true);

    const page = await getTimeline('pat_01', 1, 2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].id).toBe(events[0].id);
    expect(page.total).toBe(events.length);
  });

  it('慢病档案含结构化体征，可手工追加且按测量时间排序', async () => {
    const before = await getChronicProfile('pat_01');
    expect(before.conditions.length).toBeGreaterThan(0);
    expect(before.measurements.length).toBeGreaterThan(0);
    expect(before.measurements[0].metric).toBeDefined();

    const now = Date.now();
    const after = await updateChronicProfile('pat_01', {
      conditions: ['高血压', '2 型糖尿病'],
      heightCm: 162,
      weightKg: 58,
      medications: [{ name: '虚构药物', dose: '5 mg', frequency: '每日一次' }],
      measurements: [
        { metric: 'bp', value: 136, secondaryValue: 88, measuredAt: now },
        { metric: 'glucose', value: 7.2, context: '餐后 2 小时', measuredAt: now + 1000 },
      ],
    });

    expect(after.conditions).toEqual(['高血压', '2 型糖尿病']);
    expect(after.medications[0]).toMatchObject({ name: '虚构药物', source: 'advisor' });
    expect(after.measurements[0]).toMatchObject({ metric: 'glucose', value: 7.2 });
    expect(after.measurements[1]).toMatchObject({ metric: 'bp', value: 136, secondaryValue: 88 });
    expect(after.measurements[0].source).toBe('advisor');

    await expect(
      updateChronicProfile('pat_01', {
        measurements: [{ metric: 'bp', value: 120, secondaryValue: 130 }],
      }),
    ).rejects.toThrow('舒张压必须小于收缩压');

    const plan = await getServicePlan('pat_01');
    expect(plan.sample).toBe(true);
    expect(plan.goals.length).toBeGreaterThan(0);
  });
});
