import { getTenant } from './api.ts';
import { apiRequest, isMockMode } from './http.ts';
import { toQuery } from './storage.ts';
import type { DashboardKpis, DashboardRange, DashboardRecentItem, DashboardValue } from '../types.ts';

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

const RECENT_ITEMS: Array<Omit<DashboardRecentItem, 'at'>> = [
  {
    id: 'draft_recent_01',
    patientName: '陈女士',
    advisorName: '李顾问',
    groupName: '陈女士-健康服务群',
    preview: '晚餐与餐后活动建议',
    outcome: 'verified',
    sandbox: false,
  },
  {
    id: 'draft_recent_02',
    patientName: '王女士',
    advisorName: '王顾问',
    groupName: '王女士-健康服务群',
    preview: '控糖主食替换建议',
    outcome: 'edit_sent',
    sandbox: false,
  },
  {
    id: 'draft_recent_03',
    patientName: '赵女士',
    advisorName: '赵顾问',
    groupName: '赵女士-健康服务群',
    preview: '睡眠作息调整建议',
    outcome: 'pending',
    sandbox: false,
  },
  {
    id: 'draft_recent_04',
    patientName: '刘先生',
    advisorName: '李顾问',
    groupName: '刘先生-健康服务群',
    preview: '复诊提醒',
    outcome: 'misroute',
    sandbox: false,
  },
  {
    id: 'draft_recent_05',
    patientName: '周女士',
    advisorName: '李顾问',
    groupName: '周女士-健康服务群',
    preview: '外食选择建议',
    outcome: 'verified',
    sandbox: false,
  },
  {
    id: 'draft_recent_06',
    patientName: '黄先生',
    advisorName: '赵顾问',
    groupName: '黄先生-健康服务群',
    preview: '运动量确认',
    outcome: 'unverified',
    sandbox: false,
  },
];

/** GET /dashboard/recent */
export async function getDashboardRecent(
  limit = 10,
): Promise<{ items: DashboardRecentItem[] }> {
  if (!isMockMode) return apiRequest(`/dashboard/recent${toQuery({ limit })}`);

  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const now = Date.now();
  return {
    items: RECENT_ITEMS.slice(0, safeLimit).map((item, index) => ({
      ...item,
      at: now - (index + 1) * 7 * 60_000 - index * 90_000,
    })),
  };
}
