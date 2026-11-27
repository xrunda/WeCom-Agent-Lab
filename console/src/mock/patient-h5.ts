/**
 * PH5-02（#231）患者 H5 邀请/绑定 mock 层。
 * 真实模式走 /zhiban/api；mock 模式使用内存虚构数据（手机号后四位展示）。
 */
import { apiRequest } from './http.ts';
import { isMockMode } from './http.ts';

export interface H5Invitation {
  id: string;
  patientId: string;
  advisorId: string;
  phoneTail: string;
  status: 'pending' | 'used' | 'expired' | 'revoked';
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface H5Session {
  id: string;
  status: 'active' | 'revoked' | 'expired';
  authMethod: 'invite_sms' | 'phone_sms';
  issuedAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  userAgentSummary: string | null;
}

export interface H5BindingView {
  binding: { bound: boolean; phoneTail: string; boundAt: number; status: string } | null;
  sessions: H5Session[];
  consents: Record<string, 'granted' | 'withdrawn' | 'never'>;
  h5Status: string;
  /** 档案还缺哪些字段（h5Status=profile_incomplete 时用来指导顾问补资料） */
  missingFields?: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

interface MockState {
  invitations: H5Invitation[];
  binding: H5BindingView;
}

const state: MockState = {
  invitations: [
    {
      id: 'pinv_mock_1',
      patientId: 'pat_mock_1',
      advisorId: 'adv_mock_1',
      phoneTail: '3421',
      status: 'used',
      expiresAt: NOW - 3 * DAY,
      usedAt: NOW - 5 * DAY,
      revokedAt: null,
      note: '首次开通',
      createdAt: NOW - 6 * DAY,
      updatedAt: NOW - 5 * DAY,
    },
  ],
  binding: {
    binding: { bound: true, phoneTail: '3421', boundAt: NOW - 5 * DAY, status: 'bound' },
    sessions: [
      {
        id: 'phs_mock_1',
        status: 'active',
        authMethod: 'invite_sms',
        issuedAt: NOW - 2 * 60 * 60 * 1000,
        expiresAt: NOW + 5 * DAY,
        lastSeenAt: NOW - 30 * 60 * 1000,
        revokedAt: null,
        userAgentSummary: 'iOS/WeChat',
      },
    ],
    consents: {
      service_basic: 'granted',
      health_processing: 'granted',
      photo_analysis: 'granted',
      team_access: 'granted',
      reminder: 'withdrawn',
    },
    h5Status: 'profile_incomplete',
  },
};

export function resetPatientH5Mock(): void {
  state.invitations = [];
  state.binding = {
    binding: null,
    sessions: [],
    consents: {
      service_basic: 'never',
      health_processing: 'never',
      photo_analysis: 'never',
      team_access: 'never',
      reminder: 'never',
    },
    h5Status: 'profile_incomplete',
  };
}

export async function getH5Binding(patientId: string): Promise<H5BindingView> {
  if (!isMockMode) return apiRequest<H5BindingView>(`/patients/${patientId}/h5-binding`);
  void patientId;
  return state.binding;
}

export async function listInvitations(patientId: string): Promise<{ items: H5Invitation[] }> {
  if (!isMockMode) return apiRequest<{ items: H5Invitation[] }>(`/patients/${patientId}/invitations`);
  return { items: [...state.invitations].sort((a, b) => b.createdAt - a.createdAt) };
}

export async function createInvitation(
  patientId: string,
  input: { phone: string; ttlHours?: number; note?: string },
): Promise<{ invitation: H5Invitation; link: string }> {
  if (!isMockMode) {
    return apiRequest<{ invitation: H5Invitation; link: string }>(
      `/patients/${patientId}/invitations`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }
  const now = Date.now();
  const invitation: H5Invitation = {
    id: `pinv_mock_${state.invitations.length + 1}`,
    patientId,
    advisorId: 'adv_mock_1',
    phoneTail: input.phone.slice(-4),
    status: 'pending',
    expiresAt: now + (input.ttlHours ?? 24) * 60 * 60 * 1000,
    usedAt: null,
    revokedAt: null,
    note: input.note ?? null,
    createdAt: now,
    updatedAt: now,
  };
  state.invitations.push(invitation);
  return {
    invitation,
    // mock 链接仅演示格式，不可用（示例标记由调用方展示）
    link: 'https://h5.example.mock/h5/invite?code=MOCK_INVITE_LINK',
  };
}

export async function revokeInvitation(id: string): Promise<{ invitation: H5Invitation }> {
  if (!isMockMode) {
    return apiRequest<{ invitation: H5Invitation }>(`/patient-invitations/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }
  const found = state.invitations.find((item) => item.id === id);
  if (found && found.status === 'pending') {
    found.status = 'revoked';
    found.revokedAt = Date.now();
  }
  return { invitation: found! };
}

export async function revokeH5Session(
  patientId: string,
  sessionId: string,
): Promise<{ ok: boolean }> {
  if (!isMockMode) {
    return apiRequest<{ ok: boolean }>(`/patients/${patientId}/h5-binding/sessions/${sessionId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }
  const session = state.binding.sessions.find((item) => item.id === sessionId);
  if (session) {
    session.status = 'revoked';
    session.revokedAt = Date.now();
  }
  return { ok: true };
}

export const H5_CONSENT_LABELS: Record<string, string> = {
  service_basic: '进入个人服务',
  health_processing: 'AI 处理健康信息',
  photo_analysis: '餐食照片识别',
  team_access: '团队查看记录',
  reminder: '提醒触达',
};
