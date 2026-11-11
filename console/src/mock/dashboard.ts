import { getTenant } from './api.ts';
import { apiRequest, isMockMode } from './http.ts';
import { toQuery } from './storage.ts';
import type { DashboardKpis, DashboardRange, DashboardValue, TeamAttention } from '../types.ts';

/**
 * A 档 KPI 的 mock 替身。真实模式下全部来自后端口径，
 * 沙盒数据不计入；这里只用于 mock 演示，且数字与示例报表分开维护。
 */
const MOCK_RANGES: Record<
  DashboardRange,
  {
    value: Omit<DashboardValue, 'range' | 'from' | 'to' | 'computedAt'>;
    kpis: Omit<DashboardKpis, 'range' | 'computedAt'>;
  }
> = {
  today: {
    value: {
      adoption: {
        original: 8,
        revised: 1,
        edited: 2,
        sentTotal: 11,
        rate: 9 / 11,
        rateFormula: '(原样 8 + 改稿后 1) / 已发出 11',
      },
      savedMinutes: 27,
      savedMinutesBasis: '（原样 8 + 改稿后 1）× 3 分钟',
      minutesPerDraft: 3,
      proactiveCareCount: 4,
      verificationPassRate: 9 / 11,
      patientsPerAdvisor: 4,
    },
    kpis: {
      onlineAgents: 12,
      proactiveToday: 4,
      memoriesToday: 3,
      draftsToday: 11,
      verificationPassRate: 9 / 11,
      avgResponseSeconds: 78,
      openAlerts: 2,
    },
  },
  week: {
    value: {
      adoption: {
        original: 49,
        revised: 6,
        edited: 9,
        sentTotal: 64,
        rate: 55 / 64,
        rateFormula: '(原样 49 + 改稿后 6) / 已发出 64',
      },
      savedMinutes: 165,
      savedMinutesBasis: '（原样 49 + 改稿后 6）× 3 分钟',
      minutesPerDraft: 3,
      proactiveCareCount: 22,
      verificationPassRate: 55 / 64,
      patientsPerAdvisor: 4,
    },
    kpis: {
      onlineAgents: 12,
      proactiveToday: 22,
      memoriesToday: 18,
      draftsToday: 64,
      verificationPassRate: 55 / 64,
      avgResponseSeconds: 81,
      openAlerts: 2,
    },
  },
  month: {
    value: {
      adoption: {
        original: 216,
        revised: 25,
        edited: 39,
        sentTotal: 280,
        rate: 241 / 280,
        rateFormula: '(原样 216 + 改稿后 25) / 已发出 280',
      },
      savedMinutes: 723,
      savedMinutesBasis: '（原样 216 + 改稿后 25）× 3 分钟',
      minutesPerDraft: 3,
      proactiveCareCount: 96,
      verificationPassRate: 241 / 280,
      patientsPerAdvisor: 4,
    },
    kpis: {
      onlineAgents: 12,
      proactiveToday: 96,
      memoriesToday: 74,
      draftsToday: 280,
      verificationPassRate: 241 / 280,
      avgResponseSeconds: 82,
      openAlerts: 3,
    },
  },
};

function rangeBounds(range: DashboardRange): { from: number; to: number } {
  const now = Date.now();
  const days = range === 'today' ? 1 : range === 'week' ? 7 : 30;
  return { from: now - days * 86_400_000, to: now };
}

/** GET /dashboard/value */
export async function getDashboardValue(range: DashboardRange = 'today'): Promise<DashboardValue> {
  if (!isMockMode) return apiRequest(`/dashboard/value${toQuery({ range })}`);
  const tenant = await getTenant();
  const minutesPerDraft = tenant.settings.writeMinutesPerDraft;
  const base = MOCK_RANGES[range].value;
  const savedCount = base.adoption.original + base.adoption.revised;
  return {
    range,
    ...rangeBounds(range),
    ...base,
    savedMinutes: savedCount * minutesPerDraft,
    savedMinutesBasis: `（原样 ${base.adoption.original} + 改稿后 ${base.adoption.revised}）× ${minutesPerDraft} 分钟`,
    minutesPerDraft,
    computedAt: Date.now(),
  };
}

/** GET /dashboard/kpis */
export async function getDashboardKpis(range: DashboardRange = 'today'): Promise<DashboardKpis> {
  if (!isMockMode) return apiRequest(`/dashboard/kpis${toQuery({ range })}`);
  return {
    range,
    ...MOCK_RANGES[range].kpis,
    computedAt: Date.now(),
  };
}

/** GET /dashboard/team-attention */
export async function getDashboardTeamAttention(): Promise<TeamAttention> {
  if (!isMockMode) return apiRequest('/dashboard/team-attention');

  const now = Date.now();
  return {
    generatedAt: now,
    people: [
      {
        advisorId: 'adv_sample_1',
        advisorName: '王顾问',
        online: true,
        patientCount: 12,
        pendingCount: 4,
        level: 'L1',
        reasons: [
          {
            code: 'queue_blocked',
            level: 'L1',
            text: '草稿已推送 42 分钟未处理，队列可能阻塞',
            waitMinutes: 42,
            draftId: 'draft_sample_blocked',
          },
          {
            code: 'unverified',
            level: 'L1',
            text: '未核验 2 条待核实',
            waitMinutes: 26,
          },
        ],
        suggestion: '去实时服务流查看阻塞草稿，必要时在告警台账释放队列',
        oldestWaitMinutes: 42,
        lastActivityAt: now - 42 * 60_000,
      },
      {
        advisorId: 'adv_sample_2',
        advisorName: '李顾问',
        online: false,
        patientCount: 8,
        pendingCount: 1,
        level: 'L2',
        reasons: [
          {
            code: 'no_reply',
            level: 'L2',
            text: '客户消息 32 分钟无人跟进',
            waitMinutes: 32,
            patientId: 'pat_sample_1',
          },
        ],
        suggestion: '查看对话，确认服务人员是否在忙，必要时转交',
        oldestWaitMinutes: 32,
        lastActivityAt: now - 32 * 60_000,
      },
    ],
    summary: {
      peopleCount: 2,
      immediateCount: 1,
      verifiedToday: 18,
      avgResponseSeconds: 180,
      unverifiedCount: 2,
    },
  };
}
