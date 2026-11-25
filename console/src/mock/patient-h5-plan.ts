/**
 * PH5-04 团队端方案审核 mock 层（契约 api §12.2）。
 * mock 数据全部虚构；真实模式走 /zhiban/api。
 */
import { apiRequest, isMockMode } from './http.ts';

export type PlanStatus =
  | 'data_pending'
  | 'generating'
  | 'generate_failed'
  | 'reviewing'
  | 'rejected'
  | 'published'
  | 'suspended'
  | 'superseded'
  | 'ended';

export interface PlanActionView {
  actionId: string;
  title: string;
  purpose: string;
  method: string;
  schedule: { kind: string; time: string };
  feedbackKind: string;
  linkedArticleIds: string[];
}

export interface PlanView {
  id: string;
  patientId: string;
  version: number;
  status: PlanStatus;
  stageGoal: string;
  startDate: string;
  endDate: string;
  foodTherapyRationale: string;
  focusPoints: string[];
  actions: PlanActionView[];
  feedbackRequirements: string[];
  generation: { source: string; model?: string; errorCode?: string; startedAt: number };
  review: { status: string; reviewerName?: string; reviewedAt?: number; note?: string };
  reviewHistory: Array<{ status: string; reviewerName?: string; at: number; note?: string }>;
  inputSnapshot: { profileEntryCount: number; takenAt: number };
  effectiveFrom: number | null;
  updatedAt: number;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const state = new Map<string, PlanView[]>();

function seed(patientId: string): PlanView[] {
  return [
    {
      id: 'hpl_mock_2',
      patientId,
      version: 2,
      status: 'reviewing',
      stageGoal: '把三餐吃规律，晚餐清淡一点',
      startDate: '2026-12-01',
      endDate: '2026-12-21',
      foodTherapyRationale: '结合你偏油的口味，先从规律三餐、晚餐清淡开始。',
      focusPoints: ['早餐增加蔬菜', '三餐按时', '晚餐不过饱'],
      actions: [
        {
          actionId: 'act_1',
          title: '早餐记录',
          purpose: '看看早餐够不够丰富',
          method: '拍照或文字记录',
          schedule: { kind: 'daily', time: '07:30' },
          feedbackKind: 'record_meal',
          linkedArticleIds: [],
        },
      ],
      feedbackRequirements: ['每晚回顾'],
      generation: { source: 'agent', model: 'demo-model', startedAt: NOW - 2 * DAY },
      review: { status: 'pending' },
      reviewHistory: [],
      inputSnapshot: { profileEntryCount: 6, takenAt: NOW - 2 * DAY },
      effectiveFrom: null,
      updatedAt: NOW - 2 * DAY,
    },
    {
      id: 'hpl_mock_1',
      patientId,
      version: 1,
      status: 'published',
      stageGoal: '先建立饮食节奏',
      startDate: '2026-11-18',
      endDate: '2026-12-08',
      foodTherapyRationale: '先从规律三餐开始。',
      focusPoints: ['三餐按时'],
      actions: [],
      feedbackRequirements: [],
      generation: { source: 'agent', startedAt: NOW - 10 * DAY },
      review: { status: 'approved', reviewerName: '陈营养师（虚构）', reviewedAt: NOW - 9 * DAY },
      reviewHistory: [
        { status: 'approved', reviewerName: '陈营养师（虚构）', at: NOW - 9 * DAY },
      ],
      inputSnapshot: { profileEntryCount: 6, takenAt: NOW - 10 * DAY },
      effectiveFrom: NOW - 9 * DAY,
      updatedAt: NOW - 9 * DAY,
    },
  ];
}

export async function listPlans(patientId: string): Promise<{ items: PlanView[] }> {
  if (!isMockMode) return apiRequest<{ items: PlanView[] }>(`/patients/${patientId}/health-plans`);
  if (!state.has(patientId)) state.set(patientId, seed(patientId));
  return { items: [...state.get(patientId)!].sort((a, b) => b.version - a.version) };
}

async function mutate(
  patientId: string,
  planId: string,
  path: string,
  patch: Partial<PlanView>,
): Promise<PlanView> {
  if (!isMockMode) {
    return apiRequest<{ plan: PlanView }>(path, { method: 'POST', body: JSON.stringify({}) }).then(
      (result) => result.plan,
    );
  }
  const plans = state.get(patientId) ?? seed(patientId);
  const record = plans.find((item) => item.id === planId);
  if (!record) throw new Error('方案不存在');
  Object.assign(record, patch, { updatedAt: Date.now() });
  state.set(patientId, plans);
  return record;
}

export async function generatePlan(
  patientId: string,
  input: { startDate: string; endDate: string },
): Promise<PlanView> {
  if (!isMockMode) {
    return apiRequest<{ plan: PlanView }>(`/patients/${patientId}/health-plans/generate`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((result) => result.plan);
  }
  const plans = state.get(patientId) ?? seed(patientId);
  const nextVersion = Math.max(...plans.map((item) => item.version)) + 1;
  const record: PlanView = {
    ...seed(patientId)[0]!,
    id: `hpl_mock_${nextVersion}`,
    version: nextVersion,
    status: 'reviewing',
    startDate: input.startDate,
    endDate: input.endDate,
    review: { status: 'pending' },
    reviewHistory: [],
    effectiveFrom: null,
    updatedAt: Date.now(),
  };
  state.set(patientId, [...plans, record]);
  return record;
}

export function publishPlan(patientId: string, planId: string, note?: string): Promise<PlanView> {
  if (!isMockMode) {
    return apiRequest<{ plan: PlanView }>(`/health-plans/${planId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }).then((result) => result.plan);
  }
  const plans = state.get(patientId) ?? [];
  for (const item of plans) {
    if (item.status === 'published') {
      item.status = 'superseded';
    }
  }
  return mutate(patientId, planId, '', {
    status: 'published',
    effectiveFrom: Date.now(),
    review: { status: 'approved', reviewerName: '当前审核人（mock）', reviewedAt: Date.now(), note },
  });
}

export function rejectPlan(patientId: string, planId: string, note: string): Promise<PlanView> {
  if (!isMockMode) {
    return apiRequest<{ plan: PlanView }>(`/health-plans/${planId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }).then((result) => result.plan);
  }
  return mutate(patientId, planId, '', {
    status: 'rejected',
    review: { status: 'rejected', reviewerName: '当前审核人（mock）', reviewedAt: Date.now(), note },
  });
}

export function changePlanStatus(
  patientId: string,
  planId: string,
  action: 'suspend' | 'resume' | 'end',
): Promise<PlanView> {
  if (!isMockMode) {
    return apiRequest<{ plan: PlanView }>(`/health-plans/${planId}/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((result) => result.plan);
  }
  const next: PlanStatus =
    action === 'suspend' ? 'suspended' : action === 'resume' ? 'published' : 'ended';
  return mutate(patientId, planId, '', { status: next });
}

export async function updatePlan(
  patientId: string,
  planId: string,
  patch: { expectedVersion: number; stageGoal?: string; focusPoints?: string[] },
): Promise<PlanView> {
  if (!isMockMode) {
    return apiRequest<{ plan: PlanView }>(`/health-plans/${planId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((result) => result.plan);
  }
  return mutate(patientId, planId, '', patch as Partial<PlanView>);
}

export const PLAN_STATUS_LABEL: Record<PlanStatus, { text: string; color: string }> = {
  data_pending: { text: '资料待补充', color: 'orange' },
  generating: { text: '生成中', color: 'blue' },
  generate_failed: { text: '生成失败', color: 'red' },
  reviewing: { text: '待审核', color: 'gold' },
  rejected: { text: '已退回', color: 'default' },
  published: { text: '已发布', color: 'green' },
  suspended: { text: '已暂停', color: 'orange' },
  superseded: { text: '已被新版替代', color: 'default' },
  ended: { text: '已结束', color: 'default' },
};
