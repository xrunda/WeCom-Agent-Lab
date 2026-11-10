import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Patient } from '../src/mock/patients.ts';
import { PatientCard } from '../src/pages/patients/PatientCard.tsx';

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

describe('患者卡片 · 存档同意', () => {
  it('未知与已同意不再在列表上显示', () => {
    const { rerender } = render(
      <PatientCard patient={patient({ consent: 'unknown' })} {...baseProps} />,
    );
    expect(screen.queryByText('存档待确认')).not.toBeInTheDocument();
    expect(screen.queryByText('已同意存档')).not.toBeInTheDocument();

    rerender(<PatientCard patient={patient({ consent: 'agreed' })} {...baseProps} />);
    expect(screen.queryByText('已同意存档')).not.toBeInTheDocument();
  });

  it('不同意存档仍然显式提示', () => {
    render(<PatientCard patient={patient({ consent: 'disagreed' })} {...baseProps} />);
    expect(screen.getByText('不同意存档')).toBeInTheDocument();
  });
});
