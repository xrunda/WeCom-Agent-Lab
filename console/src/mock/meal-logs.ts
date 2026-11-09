/**
 * 饮食记录 mock：数据来自 P1 fixtures；mock 模式统一返回内联占位图。
 * 真实模式走 GET /patients/{id}/meal-logs（docs/P1-api.md §5）。
 */
import mealLogsFixture from './fixtures/meal-logs.json';
import { API_BASE, ApiError, isMockMode } from './http.ts';
import { mediaUrl } from './media.ts';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface MealFood {
  name: string;
  portion: string;
}

export interface MealLog {
  id: string;
  patientId: string;
  groupId: string;
  messageId: string;
  mediaId: string;
  photoUrl: string;
  mealType: MealType;
  foods: MealFood[];
  notes: string;
  agentComment: string;
  confidence: number;
  sandbox: boolean;
  createdAt: number;
}

const seed = mealLogsFixture as unknown as MealLog[];

export async function listMealLogs(patientId: string): Promise<MealLog[]> {
  if (!isMockMode) {
    const response = await fetch(
      `${API_BASE}/patients/${encodeURIComponent(patientId)}/meal-logs`,
      { credentials: 'include' },
    );
    const payload = (await response.json().catch(() => null)) as
      | { items?: MealLog[] }
      | { error?: { code?: string; message?: string } }
      | null;
    if (!response.ok) {
      const error = payload && 'error' in payload ? payload.error : undefined;
      throw new ApiError(
        error?.code || 'INTERNAL',
        error?.message || `请求失败（HTTP ${response.status}）`,
        response.status,
      );
    }
    return (payload as { items: MealLog[] }).items;
  }

  return seed
    .filter((item) => item.patientId === patientId && !item.sandbox)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => ({
      ...item,
      photoUrl: mediaUrl(item.mediaId, 'meal', MEAL_TYPE_LABELS[item.mealType]),
    }));
}

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};
