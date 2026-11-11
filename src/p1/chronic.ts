/**
 * 慢病管理（原「健康档案」）结构化模型。
 *
 * 设计取舍：
 * - P1 不做完整病历，也不存检验报告原文；只保留顾问/Agent 明确录入的
 *   慢病标签、体征数值与用药清单，能支撑「下一轮对话里提醒复测」即可；
 * - 体征按「指标 + 测量时间 + 来源」存成流水，最新一条即当前值；
 * - 来源只有 advisor / agent 两种，页面必须能区分，避免把模型推断当成
 *   顾问确认过的事实；
 * - 所有写操作都走 applyChronicPatch，控制台与 Agent 工具共用同一套校验，
 *   避免两处口径不一致。
 */
import type { ValidationResult } from './reply-tools.ts';

/** 常见慢病预设；控制台可多选，也允许手工补充其他诊断 */
export const CHRONIC_CONDITION_PRESETS = [
  '高血压',
  '2 型糖尿病',
  '1 型糖尿病',
  '高脂血症',
  '冠心病',
  '慢性心力衰竭',
  '慢性肾脏病',
  '慢性阻塞性肺疾病',
  '哮喘',
  '痛风',
  '高尿酸血症',
  '脂肪肝',
  '骨质疏松',
  '甲状腺功能异常',
  '脑卒中后遗症',
  '类风湿关节炎',
  '慢性胃炎',
] as const;

export interface ChronicMetricSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  /** 血压需要舒张压，其余指标为单一数值 */
  dual?: { label: string; min: number; max: number };
  /** 血糖等指标允许补充测量情境 */
  contexts?: readonly string[];
}

export const CHRONIC_METRICS = {
  bp: {
    label: '血压',
    unit: 'mmHg',
    min: 50,
    max: 260,
    dual: { label: '舒张压', min: 30, max: 180 },
  },
  glucose: {
    label: '血糖',
    unit: 'mmol/L',
    min: 1,
    max: 40,
    contexts: ['空腹', '餐后 2 小时', '随机', '睡前'],
  },
  hba1c: { label: '糖化血红蛋白', unit: '%', min: 3, max: 20 },
  weight: { label: '体重', unit: 'kg', min: 20, max: 250 },
  heart_rate: { label: '心率', unit: '次/分', min: 30, max: 220 },
  uric_acid: { label: '血尿酸', unit: 'μmol/L', min: 50, max: 1200 },
  ldl: { label: '低密度脂蛋白', unit: 'mmol/L', min: 0.2, max: 15 },
} as const satisfies Record<string, ChronicMetricSpec>;

export type ChronicMetric = keyof typeof CHRONIC_METRICS;

export const CHRONIC_METRIC_KEYS = Object.keys(CHRONIC_METRICS) as ChronicMetric[];

export type ChronicSource = 'advisor' | 'agent';

export const CHRONIC_SOURCE_LABELS: Record<ChronicSource, string> = {
  advisor: '顾问录入',
  agent: '对话提取',
};

export interface ChronicMeasurement {
  id: string;
  metric: ChronicMetric;
  value: number;
  /** 血压的舒张压；其他指标为空 */
  secondaryValue?: number;
  /** 血糖的测量情境：空腹 / 餐后 2 小时 / 随机 / 睡前 */
  context?: string;
  measuredAt: number;
  source: ChronicSource;
  recordedAt: number;
  recordedBy?: string;
}

export interface ChronicMedication {
  name: string;
  dose?: string;
  frequency?: string;
  note?: string;
  source: ChronicSource;
  updatedAt: number;
  updatedBy?: string;
}

export interface ChronicProfile {
  patientId: string;
  tenantId: string;
  conditions: string[];
  heightCm?: number;
  weightKg?: number;
  medications: ChronicMedication[];
  /** 最新在前；单患者最多保留 500 条 */
  measurements: ChronicMeasurement[];
  notes?: string;
  updatedAt: number;
  updatedBy?: string;
}

export interface ChronicActor {
  /** 控制台账号 id；Agent 写入时为空 */
  id?: string;
  name?: string;
  source: ChronicSource;
}

export interface ChronicMeasurementInput {
  metric: ChronicMetric;
  value: number;
  secondaryValue?: number;
  context?: string;
  measuredAt?: number;
  recordedAt?: number;
}

export interface ChronicMedicationInput {
  name: string;
  dose?: string;
  frequency?: string;
  note?: string;
}

export interface ChronicProfilePatch {
  /** 传数组视为整体替换；空数组表示清空 */
  conditions?: string[];
  heightCm?: number | null;
  weightKg?: number | null;
  /** 传数组视为整体替换；不做单条增删 */
  medications?: ChronicMedicationInput[];
  notes?: string | null;
  /** 追加体征；控制台单条录入时也走这里 */
  measurements?: ChronicMeasurementInput[];
}

export interface ChronicRecordInput {
  measurements?: ChronicMeasurementInput[];
  conditions?: string[];
  notes?: string;
}

export const CHRONIC_MEASUREMENT_LIMIT = 500;
export const CHRONIC_CONDITION_LIMIT = 30;
export const CHRONIC_MEDICATION_LIMIT = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text.slice(0, max);
}

export function isChronicMetric(value: unknown): value is ChronicMetric {
  return typeof value === 'string' && Object.hasOwn(CHRONIC_METRICS, value);
}

/** 展示用：血压为 138/86，其余带单位 */
export function formatMeasurementValue(input: {
  metric: ChronicMetric;
  value: number;
  secondaryValue?: number;
}): string {
  const spec: ChronicMetricSpec = CHRONIC_METRICS[input.metric];
  if (spec.dual) {
    return `${input.value}/${input.secondaryValue ?? '—'} ${spec.unit}`;
  }
  return `${input.value} ${spec.unit}`;
}

export function chronicConditions(value: unknown, violations: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    violations.push('conditions 必须是字符串数组');
    return undefined;
  }
  if (value.length > CHRONIC_CONDITION_LIMIT) {
    violations.push(`conditions 最多 ${CHRONIC_CONDITION_LIMIT} 项`);
  }
  const seen = new Set<string>();
  const conditions: string[] = [];
  for (const item of value) {
    const text = item.trim();
    if (text === '') continue;
    if (text.length > 30) {
      violations.push('慢病名称不能超过 30 个字符');
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    conditions.push(text);
  }
  return conditions.slice(0, CHRONIC_CONDITION_LIMIT);
}

function metricNumber(
  value: unknown,
  spec: { min: number; max: number },
  field: string,
  violations: string[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    violations.push(`${field} 必须是数字`);
    return undefined;
  }
  if (value < spec.min || value > spec.max) {
    violations.push(`${field} 需在 ${spec.min}–${spec.max} 之间`);
    return undefined;
  }
  return value;
}

/** 解析控制台/Agent 传入的测量时间：毫秒或 ISO 字符串；缺省用 now */
export function chronicMeasuredAt(
  value: unknown,
  now: number,
  field: string,
  violations: string[],
): number {
  if (value === undefined || value === null || value === '') return now;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    violations.push(`${field} 必须是毫秒时间戳或 ISO 时间`);
    return now;
  }
  // 不允许未来时间，避免把 2088 年误填成当前值
  if (parsed > now + 5 * 60_000) {
    violations.push(`${field} 不能晚于当前时间`);
    return now;
  }
  return parsed;
}

export function validateMeasurementInput(
  value: unknown,
  now: number,
  field: string,
  violations: string[],
): ChronicMeasurementInput | undefined {
  if (!isRecord(value)) {
    violations.push(`${field} 必须是对象`);
    return undefined;
  }
  const before = violations.length;
  if (!isChronicMetric(value.metric)) {
    violations.push(`${field}.metric 必须是 ${CHRONIC_METRIC_KEYS.join('/')}`);
    return undefined;
  }
  const spec: ChronicMetricSpec = CHRONIC_METRICS[value.metric];
  const number = metricNumber(value.value, spec, `${field}.value`, violations);
  let secondaryValue: number | undefined;
  if (spec.dual) {
    secondaryValue = metricNumber(
      value.secondaryValue,
      spec.dual,
      `${field}.secondaryValue`,
      violations,
    );
    if (secondaryValue !== undefined && number !== undefined && secondaryValue >= number) {
      violations.push(`${field}.secondaryValue 必须小于收缩压`);
    }
  } else if (value.secondaryValue !== undefined) {
    violations.push(`${field}.secondaryValue 只用于血压`);
  }
  const context = boundedString(value.context, 20);
  if (value.context !== undefined && context === undefined) {
    violations.push(`${field}.context 不能为空`);
  }
  if (context && spec.contexts && !spec.contexts.includes(context)) {
    violations.push(`${field}.context 必须是 ${spec.contexts.join('/')}`);
  }
  const measuredAt = chronicMeasuredAt(
    value.measuredAt,
    now,
    `${field}.measuredAt`,
    violations,
  );
  if (violations.length > before) return undefined;
  return {
    metric: value.metric,
    value: number as number,
    ...(secondaryValue !== undefined ? { secondaryValue } : {}),
    ...(context ? { context } : {}),
    measuredAt,
  };
}

export function validateMedicationsInput(
  value: unknown,
  violations: string[],
): ChronicMedicationInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    violations.push('medications 必须是数组');
    return undefined;
  }
  if (value.length > CHRONIC_MEDICATION_LIMIT) {
    violations.push(`medications 最多 ${CHRONIC_MEDICATION_LIMIT} 条`);
  }
  const medications: ChronicMedicationInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      violations.push('medications 每项必须是对象');
      continue;
    }
    const name = boundedString(item.name, 60);
    if (!name) {
      violations.push('medications.name 不能为空');
      continue;
    }
    const dose = boundedString(item.dose, 40);
    const frequency = boundedString(item.frequency, 40);
    const note = boundedString(item.note, 120);
    medications.push({
      name,
      ...(dose ? { dose } : {}),
      ...(frequency ? { frequency } : {}),
      ...(note ? { note } : {}),
    });
  }
  return medications.slice(0, CHRONIC_MEDICATION_LIMIT);
}

export type ChronicPatchResult =
  | { ok: true; value: ChronicProfilePatch }
  | { ok: false; violations: string[] };

/** 控制台 PATCH 入参校验（不依赖当前档案） */
export function validateChronicPatch(args: unknown, now: number): ChronicPatchResult {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const violations: string[] = [];
  const patch: ChronicProfilePatch = {};

  const conditions = chronicConditions(args.conditions, violations);
  if (conditions !== undefined) patch.conditions = conditions;

  if (args.heightCm !== undefined) {
    if (args.heightCm === null) patch.heightCm = null;
    else patch.heightCm = metricNumber(args.heightCm, { min: 80, max: 250 }, 'heightCm', violations);
  }
  if (args.weightKg !== undefined) {
    if (args.weightKg === null) patch.weightKg = null;
    else patch.weightKg = metricNumber(args.weightKg, { min: 20, max: 250 }, 'weightKg', violations);
  }

  const medications = validateMedicationsInput(args.medications, violations);
  if (medications !== undefined) patch.medications = medications;

  if (args.notes !== undefined) {
    if (args.notes === null) patch.notes = null;
    else {
      const notes = boundedString(args.notes, 500);
      if (notes === undefined) violations.push('notes 不能为空');
      else patch.notes = notes;
    }
  }

  const rawMeasurements =
    args.measurements !== undefined
      ? args.measurements
      : args.measurement !== undefined
        ? [args.measurement]
        : undefined;
  if (rawMeasurements !== undefined) {
    if (!Array.isArray(rawMeasurements)) {
      violations.push('measurements 必须是数组');
    } else if (rawMeasurements.length > 5) {
      violations.push('measurements 一次最多 5 条');
    } else {
      const measurements: ChronicMeasurementInput[] = [];
      rawMeasurements.forEach((item, index) => {
        const measurement = validateMeasurementInput(
          item,
          now,
          `measurements[${index}]`,
          violations,
        );
        if (measurement) measurements.push(measurement);
      });
      if (measurements.length > 0) patch.measurements = measurements;
    }
  }

  if (violations.length > 0) return { ok: false, violations };
  if (Object.keys(patch).length === 0) {
    return { ok: false, violations: ['至少提供一个可更新字段'] };
  }
  return { ok: true, value: patch };
}

/** Agent 工具入参：一次最多 5 条体征，明确数值才写 */
export function validateChronicRecord(args: unknown, now: number): ValidationResult<ChronicRecordInput> {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const violations: string[] = [];

  const measurements: ChronicMeasurementInput[] = [];
  if (args.measurements !== undefined) {
    if (!Array.isArray(args.measurements)) {
      violations.push('measurements 必须是数组');
    } else if (args.measurements.length > 5) {
      violations.push('measurements 一次最多 5 条');
    } else {
      args.measurements.forEach((item, index) => {
        const parsed = validateMeasurementInput(item, now, `measurements[${index}]`, violations);
        if (parsed) measurements.push(parsed);
      });
    }
  }

  const conditions = chronicConditions(args.conditions, violations);
  const notes = boundedString(args.notes, 500);
  if (args.notes !== undefined && typeof args.notes !== 'string') {
    violations.push('notes 必须是字符串');
  }

  if (violations.length > 0) return { ok: false, violations };
  if (measurements.length === 0 && conditions === undefined && notes === undefined) {
    return { ok: false, violations: ['至少提供一条体征、慢病标签或备注'] };
  }
  return {
    ok: true,
    value: {
      ...(measurements.length > 0 ? { measurements } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

export interface ApplyChronicPatchOptions {
  now: number;
  actor: ChronicActor;
  nextMeasurementId: () => string;
}

/** 把校验后的补丁合并到档案；返回新对象，不修改入参 */
export function applyChronicPatch(
  profile: ChronicProfile,
  patch: ChronicProfilePatch,
  options: ApplyChronicPatchOptions,
): ChronicProfile {
  const { now, actor } = options;
  const next: ChronicProfile = {
    ...profile,
    conditions: [...profile.conditions],
    medications: [...profile.medications],
    measurements: [...profile.measurements],
  };

  if (patch.conditions !== undefined) next.conditions = [...patch.conditions];
  if (patch.heightCm !== undefined) {
    if (patch.heightCm === null) delete next.heightCm;
    else next.heightCm = patch.heightCm;
  }
  if (patch.weightKg !== undefined) {
    if (patch.weightKg === null) delete next.weightKg;
    else next.weightKg = patch.weightKg;
  }
  if (patch.notes !== undefined) {
    if (patch.notes === null) delete next.notes;
    else next.notes = patch.notes;
  }
  if (patch.medications !== undefined) {
    next.medications = patch.medications.map((item) => ({
      ...item,
      source: actor.source,
      updatedAt: now,
      ...(actor.name ? { updatedBy: actor.name } : {}),
    }));
  }
  if (patch.measurements !== undefined && patch.measurements.length > 0) {
    const added = patch.measurements.map((measurement) => ({
      id: options.nextMeasurementId(),
      metric: measurement.metric,
      value: measurement.value,
      ...(measurement.secondaryValue !== undefined
        ? { secondaryValue: measurement.secondaryValue }
        : {}),
      ...(measurement.context ? { context: measurement.context } : {}),
      measuredAt: measurement.measuredAt ?? now,
      source: actor.source,
      recordedAt: now,
      ...(actor.name ? { recordedBy: actor.name } : {}),
    }));
    next.measurements = [...added, ...next.measurements]
      .sort(
        (a, b) =>
          b.measuredAt - a.measuredAt || b.recordedAt - a.recordedAt ||
          b.id.localeCompare(a.id),
      )
      .slice(0, CHRONIC_MEASUREMENT_LIMIT);
  }

  next.updatedAt = now;
  if (actor.name) next.updatedBy = actor.name;
  return next;
}

export function emptyChronicProfile(patientId: string, tenantId: string): ChronicProfile {
  return {
    patientId,
    tenantId,
    conditions: [],
    medications: [],
    measurements: [],
    updatedAt: 0,
  };
}

/** 取每个指标最新一条；血压优先取血压，体重与体征分开看 */
export function latestMeasurements(profile: ChronicProfile): Map<ChronicMetric, ChronicMeasurement> {
  const latest = new Map<ChronicMetric, ChronicMeasurement>();
  for (const measurement of profile.measurements) {
    if (!latest.has(measurement.metric)) latest.set(measurement.metric, measurement);
  }
  return latest;
}
