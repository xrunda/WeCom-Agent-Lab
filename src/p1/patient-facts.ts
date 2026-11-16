/**
 * 患者事实卡（#167）：把「与餐食/日常建议相关、且有数据来源」的字段拼成固定顺序的短文本。
 *
 * 两个 Agent 共用同一份渲染：
 * - 患者 Agent 生成草稿时每轮注入（确定性，不依赖模型自觉调用）；
 * - 顾问 Agent 的 `patient_chronic` 工具返回同一张卡（再附长期记忆）。
 *
 * 只放档案里真实存在的字段；缺项不写、不猜。长期记忆由 zhiban-memory 自己渲染，
 * 这里不重复拼，避免两套格式。
 */
import { CHRONIC_METRICS, CHRONIC_SOURCE_LABELS, formatMeasurementValue } from './chronic.ts';
import type { ChronicProfile } from './chronic.ts';
import type { MealLogRecord } from './vision.ts';

/** 餐次中文名；顾问工具与事实卡共用 */
export const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

/** 上海时区的 MM-DD HH:mm；事实卡只读展示用 */
export function formatShanghaiDateTime(ms: number): string {
  const date = new Date(ms + 8 * 3_600_000);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

export interface PatientFactsInput {
  displayName: string;
  tags?: string[];
  chronic?: ChronicProfile;
  /** 最近几条饮食记录（已按时间倒序）；默认最多 2 条 */
  recentMeals?: MealLogRecord[];
  maxMeals?: number;
}

const MEASUREMENT_LIMIT = 3;
const MEDICATION_LIMIT = 10;
const CONDITION_LIMIT = 10;

function mealLine(meal: MealLogRecord): string {
  const label = MEAL_TYPE_LABELS[meal.mealType] ?? meal.mealType;
  const foods = meal.foods
    .map((food) => (food.portion ? `${food.name}（${food.portion}）` : food.name))
    .join('、');
  return `${formatShanghaiDateTime(meal.createdAt)} ${label} ${foods}`;
}

/**
 * 生成事实卡文本行。没有任何可用字段时返回空数组（调用方不注入空块）。
 */
export function buildPatientFacts(input: PatientFactsInput): string[] {
  const lines: string[] = [];
  const profile = input.chronic;
  const tags = (input.tags ?? []).filter((tag) => tag.trim() !== '');

  const header = `【患者事实卡】${input.displayName}${tags.length > 0 ? `（标签：${tags.join('、')}）` : ''}`;
  const body: string[] = [];

  if (profile) {
    if (profile.conditions.length > 0) {
      body.push(`疾病：${profile.conditions.slice(0, CONDITION_LIMIT).join('、')}`);
    }
    const size: string[] = [];
    if (profile.heightCm !== undefined) size.push(`${profile.heightCm} cm`);
    if (profile.weightKg !== undefined) size.push(`${profile.weightKg} kg`);
    if (size.length > 0) body.push(`身高体重：${size.join(' / ')}`);
    if (profile.medications.length > 0) {
      body.push(
        `用药：${profile.medications
          .slice(0, MEDICATION_LIMIT)
          .map((med) => (med.dose ? `${med.name} ${med.dose}` : med.name))
          .join('、')}`,
      );
    }
    const measurements = profile.measurements.slice(0, MEASUREMENT_LIMIT).map((measurement) => {
      const spec = CHRONIC_METRICS[measurement.metric];
      const context = measurement.context ? `（${measurement.context}）` : '';
      return `${spec.label}：${formatMeasurementValue(measurement)}${context} · ` +
        `${formatShanghaiDateTime(measurement.measuredAt)} · ${CHRONIC_SOURCE_LABELS[measurement.source]}`;
    });
    if (measurements.length > 0) body.push(`最近体征：${measurements.join('；')}`);
  }

  const meals = (input.recentMeals ?? []).slice(0, input.maxMeals ?? 2);
  if (meals.length > 0) {
    body.push(`最近饮食：${meals.map(mealLine).join('；')}`);
  }

  if (body.length === 0) return [];
  lines.push(header);
  for (const line of body) lines.push(`· ${line}`);
  lines.push('以上均为档案里已有的记录；没有的字段不要猜。');
  return lines;
}
