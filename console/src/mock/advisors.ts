import advisorsFixture from './fixtures/advisors.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';

export type AdvisorStatus = 'active' | 'paused' | 'left';

export interface Advisor {
  id: string;
  tenantId: string;
  wecomUserId: string;
  name: string;
  status: AdvisorStatus;
  seatExpireAt: number | null;
  chatBound: boolean;
  online: boolean;
  queueDepth: number;
  consecutiveMisroutes: number;
  pausedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const ADVISOR_STATUS_LABELS: Record<AdvisorStatus, string> = {
  active: '在岗',
  paused: '已暂停',
  left: '已离职',
};

export interface SeatCost {
  seats: number;
  pricePerSeat: number;
  annualCost: number;
}

/** 席位成本 = 未离职顾问数 × 单价（默认 900 元/人/年，单价来自租户设置）。 */
export function seatCost(advisors: Advisor[], pricePerSeat: number): SeatCost {
  const seats = advisors.filter((item) => item.status !== 'left').length;
  return { seats, pricePerSeat, annualCost: seats * pricePerSeat };
}

const STATE_KEY = 'zhiban.console.k.advisors';
let cachedAdvisors: Advisor[] | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readAdvisors(): Advisor[] {
  if (cachedAdvisors) return cachedAdvisors;
  try {
    const raw = localStorage.getItem(STATE_KEY);
    cachedAdvisors = raw ? (JSON.parse(raw) as Advisor[]) : (clone(advisorsFixture) as unknown as Advisor[]);
  } catch {
    cachedAdvisors = clone(advisorsFixture) as unknown as Advisor[];
  }
  return cachedAdvisors;
}

function writeAdvisors(advisors: Advisor[]): void {
  cachedAdvisors = advisors;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(advisors));
  } catch {
    // 隐私模式或存储被禁用时使用内存状态
  }
}

/** 仅供测试：清除本地改动并恢复到 fixtures。 */
export function resetAdvisorsMock(): void {
  cachedAdvisors = null;
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    // 同上
  }
}

export async function listAdvisors(status?: AdvisorStatus | ''): Promise<Advisor[]> {
  if (!isMockMode) {
    return apiRequest<{ items: Advisor[] }>(
      `/advisors${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ).then((result) => result.items);
  }

  return readAdvisors()
    .filter((item) => (status ? item.status === status : true))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh-CN'));
}

export async function pauseAdvisor(advisorId: string, reason?: string): Promise<Advisor> {
  if (!isMockMode) {
    return apiRequest<Advisor>(`/advisors/${advisorId}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? '手动暂停' }),
    });
  }

  const advisors = readAdvisors();
  const advisor = advisors.find((item) => item.id === advisorId);
  if (!advisor) throw new ApiError('NOT_FOUND', '顾问不存在', 404);
  if (advisor.status === 'left') throw new ApiError('CONFLICT', '已离职顾问不能暂停', 409);

  advisor.status = 'paused';
  advisor.online = false;
  advisor.pausedAt = Date.now();
  advisor.updatedAt = advisor.pausedAt;
  writeAdvisors(advisors);
  return advisor;
}

export async function resumeAdvisor(advisorId: string): Promise<Advisor> {
  if (!isMockMode) {
    return apiRequest<Advisor>(`/advisors/${advisorId}/resume`, { method: 'POST' });
  }

  const advisors = readAdvisors();
  const advisor = advisors.find((item) => item.id === advisorId);
  if (!advisor) throw new ApiError('NOT_FOUND', '顾问不存在', 404);
  if (advisor.status === 'left') throw new ApiError('CONFLICT', '已离职顾问不能恢复', 409);

  advisor.status = 'active';
  advisor.pausedAt = null;
  advisor.consecutiveMisroutes = 0;
  advisor.updatedAt = Date.now();
  writeAdvisors(advisors);
  return advisor;
}

export interface AdvisorPerformanceRow {
  advisorId: string;
  name: string;
  draftsSent: number;
  adoptionRate: number;
  avgResponseSeconds: number;
  misroutes: number;
  sample: true;
}

/** 顾问绩效为 B 档，仅提供示例数据。 */
export function samplePerformance(advisors: Advisor[]): AdvisorPerformanceRow[] {
  return advisors.map((advisor, index) => ({
    advisorId: advisor.id,
    name: advisor.name,
    draftsSent: 18 + index * 7,
    adoptionRate: Number((0.92 - index * 0.05).toFixed(2)),
    avgResponseSeconds: 95 + index * 22,
    misroutes: index % 3 === 0 ? 1 : 0,
    sample: true,
  }));
}
