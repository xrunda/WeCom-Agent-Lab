import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindGroupMember,
  bindPatient,
  listGroups,
  pendingGroupCount,
  resetGroupsMock,
  updateGroup,
} from '../src/mock/groups.ts';
import { listGroupMembers, listPatients, resetPatientsMock } from '../src/mock/patients.ts';

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

  it('改群名后 nameSource 变为 manual（不再被企微群名同步覆盖）', async () => {
    const updated = await updateGroup('grp_01', { name: '控糖-张女士' });
    expect(updated).toMatchObject({ name: '控糖-张女士', nameSource: 'manual' });
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

  it('从群成员选服务对象：建患者并确认身份，重复选择复用同一位患者', async () => {
    const members = await listGroupMembers('grp_04');
    const member = members.find((item) => item.isExternal && item.externalUserId);
    expect(member).toBeTruthy();

    const first = await bindGroupMember('grp_04', member!.id);
    expect(first.patient.externalUserId).toBe(member!.externalUserId);
    expect(first.patient.identityStatus).toBe('confirmed');

    const group = (await listGroups()).items.find((item) => item.id === 'grp_04');
    expect(group?.patientIds).toEqual([first.patient.id]);

    const before = (await listPatients()).items.length;
    const second = await bindGroupMember('grp_04', member!.id);
    expect(second.patient.id).toBe(first.patient.id);
    expect((await listPatients()).items.length).toBe(before);
  });

  it('内部成员不能作为服务对象，未知成员报校验错误', async () => {
    const members = await listGroupMembers('grp_01');
    const staff = members.find((item) => !item.isExternal);
    expect(staff).toBeTruthy();

    await expect(bindGroupMember('grp_04', staff!.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(bindGroupMember('grp_04', 'gm_404')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
