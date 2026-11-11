import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getPatientDetail,
  listGroupMembers,
  resetPatientsMock,
  setPatientIdentity,
  type Patient,
} from '../src/mock/patients.ts';
import { PatientCard } from '../src/pages/patients/PatientCard.tsx';
import { PatientIdentityModal } from '../src/pages/patients/PatientIdentityModal.tsx';

function patient(overrides: Partial<Patient> = {}): Patient {
  const now = Date.now();
  return {
    id: 'pat_1',
    tenantId: 'tenant_1',
    displayName: '汪星',
    avatar: null,
    externalUserId: 'wm_demo',
    tags: [],
    advisorId: 'adv_1',
    groupIds: ['grp_1'],
    consent: 'unknown',
    consentCheckedAt: null,
    status: 'serving',
    demo: false,
    accompaniedSince: now,
    lastActiveAt: now,
    memoryCount: 0,
    pendingPlanCount: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

const baseProps = {
  term: '患者',
  online: true,
  advisorName: '顾问甲',
  onOpen: () => undefined,
};

beforeEach(() => {
  resetPatientsMock();
});

describe('患者卡片 · 身份状态', () => {
  it('身份待确认时显示可行动标签', () => {
    render(<PatientCard patient={patient({ identityStatus: 'pending' })} {...baseProps} />);
    expect(screen.getByText('身份待确认')).toBeInTheDocument();
  });

  it('身份已确认时不在卡片上占位', () => {
    render(
      <PatientCard patient={patient({ identityStatus: 'confirmed' })} {...baseProps} />,
    );
    expect(screen.queryByText('身份待确认')).not.toBeInTheDocument();
  });
});

describe('患者身份 mock 接口', () => {
  it('改绑后患者标记已确认，成员角色随之调整', async () => {
    const before = await listGroupMembers('grp_07');
    const family = before.find((member) => member.role === 'family');
    expect(family?.externalUserId).toBeTruthy();

    const updated = await setPatientIdentity('pat_06', {
      groupId: 'grp_07',
      externalUserId: family!.externalUserId!,
    });
    expect(updated.identityStatus).toBe('confirmed');
    expect(updated.identitySource).toBe('manual');
    expect(updated.externalUserId).toBe(family!.externalUserId);

    const after = await listGroupMembers('grp_07');
    expect(after.find((member) => member.externalUserId === family!.externalUserId)?.role).toBe(
      'self',
    );
    expect(after.find((member) => member.role === 'self')?.externalUserId).toBe(
      family!.externalUserId,
    );
  });

  it('未绑定的服务群拒绝改绑', async () => {
    await expect(
      setPatientIdentity('pat_06', { groupId: 'grp_01', externalUserId: 'wm_demo_zhang' }),
    ).rejects.toThrow(/未绑定/);
  });

  it('内部员工不能作为患者目标', async () => {
    const members = await listGroupMembers('grp_07');
    const advisor = members.find((member) => !member.isExternal);
    expect(advisor).toBeTruthy();
    await expect(
      setPatientIdentity('pat_06', {
        groupId: 'grp_07',
        externalUserId: advisor!.staffUserId ?? 'staff',
      }),
    ).rejects.toThrow(/外部成员/);
  });
});

describe('患者身份确认弹窗', () => {
  it('选择群内成员并确认后，患者身份变为已确认', async () => {
    const detail = await getPatientDetail('pat_06');
    const user = userEvent.setup();
    let saved = 0;

    render(
      <ConfigProvider locale={zhCN}>
        <App>
          <PatientIdentityModal
            open
            detail={detail}
            term="患者"
            onClose={() => undefined}
            onSaved={() => {
              saved += 1;
            }}
          />
        </App>
      </ConfigProvider>,
    );

    await waitFor(() => expect(screen.getByText(/郑先生的家属/)).toBeInTheDocument());
    await user.click(screen.getByText(/郑先生的家属/));
    await user.click(screen.getByRole('button', { name: '确认身份' }));

    await waitFor(() => expect(saved).toBe(1));
    const after = await getPatientDetail('pat_06');
    expect(after.patient.identityStatus).toBe('confirmed');
  });
});
