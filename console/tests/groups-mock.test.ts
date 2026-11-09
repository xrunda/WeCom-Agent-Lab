import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindPatient,
  listGroups,
  pendingGroupCount,
  resetGroupsMock,
  updateGroup,
} from '../src/mock/groups.ts';
import { listPatients, resetPatientsMock } from '../src/mock/patients.ts';

beforeEach(() => {
  resetGroupsMock();
  resetPatientsMock();
});

describe('服务群 mock 数据', () => {
  it('待确认群只统计 pending', () => {
    expect(pendingGroupCount()).toBe(1);
  });

  it('切换状态后筛选结果同步', async () => {
    const pending = await listGroups({ status: 'pending' });
    expect(pending.items.map((item) => item.id)).toEqual(['grp_04']);

    await updateGroup('grp_04', { status: 'collect_only' });
    expect(await listGroups({ status: 'pending' })).toMatchObject({ total: 0 });
    const collectOnly = await listGroups({ status: 'collect_only' });
    expect(collectOnly.items.map((item) => item.id)).toContain('grp_04');
  });

  it('改群名后 nameSource 变为 config', async () => {
    const updated = await updateGroup('grp_01', { name: '控糖-张女士' });
    expect(updated).toMatchObject({ name: '控糖-张女士', nameSource: 'config' });
  });

  it('可以绑定已有患者，重复绑定报冲突', async () => {
    const result = await bindPatient('grp_04', { patientId: 'pat_02' });
    expect(result.binding.patientId).toBe('pat_02');

    const group = (await listGroups()).items.find((item) => item.id === 'grp_04');
    expect(group?.patientIds).toContain('pat_02');

    const patient = (await listPatients()).items.find((item) => item.id === 'pat_02');
    expect(patient?.groupIds).toContain('grp_04');

    await expect(bindPatient('grp_04', { patientId: 'pat_02' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('可以新建患者并绑定', async () => {
    const result = await bindPatient('grp_08', {
      newPatient: { displayName: '测试患者', tags: ['作息'], consent: 'unknown' },
    });
    expect(result.patient.displayName).toBe('测试患者');

    const group = (await listGroups()).items.find((item) => item.id === 'grp_08');
    expect(group?.patientIds).toContain(result.patient.id);
  });
});
