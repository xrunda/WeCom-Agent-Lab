/**
 * PH5-03（#232）患者端 H5：轻量建档（patient_profile_entries）。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.5（字段、来源、安全规则）。
 *
 * 安全规则（A03 验收依据）：
 * - `allergy` / `existing_guidance` 的 agent 来源条目不覆盖 patient/professional
 * - 关键安全信息缺失（无 allergy 记录）或自述与专业确认冲突 → data_pending，
 *   不进入可执行建议
 * - 「不清楚」是合法取值，不等同于「无过敏」
 */
import type { IdFactory } from './ids.ts';
import type { IdempotencyRecord } from './patient-h5.ts';

export type ProfileFieldKey =
  | 'goal'
  | 'meal_times'
  | 'sleep_time'
  | 'food_preference'
  | 'allergy'
  | 'existing_guidance';

export const PROFILE_FIELD_KEYS: readonly ProfileFieldKey[] = [
  'goal',
  'meal_times',
  'sleep_time',
  'food_preference',
  'allergy',
  'existing_guidance',
];

/** 建档分步（契约 api §4.3） */
export type ProfileStep = 'basics' | 'routine' | 'food' | 'safety' | 'guidance';

export const STEP_FIELDS: Record<ProfileStep, ProfileFieldKey[]> = {
  basics: ['goal'],
  routine: ['meal_times', 'sleep_time'],
  food: ['food_preference'],
  safety: ['allergy'],
  guidance: ['existing_guidance'],
};

export type ProfileSource = 'patient' | 'advisor' | 'agent' | 'professional';
export type ProfileEntryStatus = 'draft' | 'confirmed' | 'disputed';

export interface ProfileEntry {
  id: string;
  tenantId: string;
  patientId: string;
  fieldKey: ProfileFieldKey;
  value: Record<string, unknown>;
  valueText: string;
  source: ProfileSource;
  status: ProfileEntryStatus;
  confirmedBy?: string;
  confirmedAt?: number;
  sourceRef?: string;
  updatedAt: number;
  revisions: Array<{ value: Record<string, unknown>; source: ProfileSource; at: number; via?: string }>;
}

export interface ProfileBackend {
  loadProfileEntries(): ProfileEntry[];
  putProfileEntry(entry: ProfileEntry): Promise<void>;
  /** 幂等存储（可选）：不实现时按无幂等处理 */
  loadIdempotency?(patientId: string, key: string, now: number): Promise<unknown>;
  putIdempotency?(record: IdempotencyRecord): Promise<void>;
}

export const FIELD_LABELS: Record<ProfileFieldKey, string> = {
  goal: '希望改善',
  meal_times: '用餐时间',
  sleep_time: '作息',
  food_preference: '饮食偏好',
  allergy: '过敏与禁忌',
  existing_guidance: '既有专业指导',
};

// ---------- 校验 ----------

export interface ValueIssue {
  field: ProfileFieldKey;
  issue: string;
}

function asStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (items.length !== value.length) return null;
  if (items.some((item) => item.length > 40) || items.length > max) return null;
  return items.map((item) => item.trim());
}

function asTimeString(value: unknown): string | null {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

/** 逐字段校验 value 结构（契约 §3.5 的 value schema） */
export function validateFieldValue(fieldKey: ProfileFieldKey, value: unknown): ValueIssue[] {
  const issues: ValueIssue[] = [];
  const fail = (issue: string): void => {
    issues.push({ field: fieldKey, issue });
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ field: fieldKey, issue: 'value 必须是对象' }];
  }
  const record = value as Record<string, unknown>;
  switch (fieldKey) {
    case 'goal': {
      if (!asStringArray(record.items, 8)) fail('items 需为 ≤8 个非空短句');
      break;
    }
    case 'meal_times': {
      const keys = ['breakfast', 'lunch', 'dinner'] as const;
      if (keys.every((key) => record[key] === undefined || record[key] === null)) {
        fail('至少填写一个用餐时间');
      }
      for (const key of keys) {
        if (record[key] === undefined || record[key] === null) continue;
        if (!asTimeString(record[key])) fail(`${key} 需为 HH:mm`);
      }
      break;
    }
    case 'sleep_time': {
      const keys = ['bedtime', 'waketime'] as const;
      if (keys.every((key) => record[key] === undefined || record[key] === null)) {
        fail('至少填写入睡或起床时间');
      }
      for (const key of keys) {
        if (record[key] === undefined || record[key] === null) continue;
        if (!asTimeString(record[key])) fail(`${key} 需为 HH:mm`);
      }
      break;
    }
    case 'food_preference': {
      for (const key of ['likes', 'dislikes'] as const) {
        if (record[key] === undefined || record[key] === null) continue;
        if (!asStringArray(record[key], 10)) fail(`${key} 需为 ≤10 个短词`);
      }
      break;
    }
    case 'allergy': {
      if (record.unknown === undefined) fail('unknown 必填（允许「不清楚」）');
      else if (typeof record.unknown !== 'boolean') fail('unknown 必须为布尔');
      if (record.items !== undefined && record.items !== null) {
        if (!asStringArray(record.items, 12)) fail('items 需为 ≤12 个短句');
      }
      break;
    }
    case 'existing_guidance': {
      if (!asStringArray(record.items, 8)) fail('items 需为 ≤8 个短句');
      if (record.sourceNote !== undefined && record.sourceNote !== null) {
        if (typeof record.sourceNote !== 'string' || record.sourceNote.length > 60) {
          fail('sourceNote ≤60 字');
        }
      }
      break;
    }
  }
  return issues;
}

/** 患者可读的一句话（列表展示） */
export function fieldValueText(fieldKey: ProfileFieldKey, value: Record<string, unknown>): string {
  const join = (items: unknown): string =>
    Array.isArray(items) ? items.filter((i) => typeof i === 'string').join('、') : '';
  switch (fieldKey) {
    case 'goal':
      return join(value.items) || '—';
    case 'meal_times':
      return `早 ${value.breakfast ?? '—'} · 午 ${value.lunch ?? '—'} · 晚 ${value.dinner ?? '—'}`;
    case 'sleep_time':
      return `${value.bedtime ?? '—'} 入睡 · ${value.waketime ?? '—'} 起床`;
    case 'food_preference':
      return `喜欢 ${join(value.likes) || '—'}；回避 ${join(value.dislikes) || '—'}`;
    case 'allergy':
      return value.unknown ? '不清楚（待补充）' : join(value.items) || '无';
    case 'existing_guidance':
      return join(value.items) || '—';
  }
}

// ---------- 服务 ----------

export interface ProfileAnswersInput {
  patientId: string;
  step: ProfileStep;
  answers: Partial<Record<ProfileFieldKey, Record<string, unknown>>>;
  decidedVia: string;
  /** 幂等键：同一步骤弱网重试时复用，24h 内返回首次结果（契约 api §4.3） */
  idempotencyKey?: string;
}

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProfileStatus {
  completeness: number;
  /** 0–1，六个必备字段已填比例 */
  safetyMissing: boolean;
  conflicts: Array<{ fieldKey: ProfileFieldKey; detail: string }>;
}

const CONFLICT_SOURCES: ReadonlySet<ProfileSource> = new Set(['patient', 'professional']);

export class ProfileService {
  private readonly backend: ProfileBackend;
  private readonly tenantId: string;
  private readonly now: () => number;
  private readonly ids: IdFactory;

  constructor(options: {
    backend: ProfileBackend;
    tenantId: string;
    now?: () => number;
    ids?: IdFactory;
  }) {
    this.backend = options.backend;
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? (() => {
      throw new Error('id factory 未配置');
    });
  }

  list(patientId: string): ProfileEntry[] {
    return this.backend
      .loadProfileEntries()
      .filter((item) => item.tenantId === this.tenantId && item.patientId === patientId);
  }

  find(patientId: string, fieldKey: ProfileFieldKey): ProfileEntry | undefined {
    return this.list(patientId).find((item) => item.fieldKey === fieldKey);
  }

  /**
   * 分步提交。source 恒为 patient；
   * 已有 professional/advisor 确认的同字段：并列为待确认草稿，不覆盖（契约 §3.5）。
   */
  async submitAnswers(input: ProfileAnswersInput): Promise<{
    entries: ProfileEntry[];
    status: ProfileStatus;
  }> {
    const fields = STEP_FIELDS[input.step];
    if (!fields) {
      throw new Error(`未知步骤：${input.step}`);
    }
    if (input.idempotencyKey && this.backend.loadIdempotency) {
      const hit = await this.backend.loadIdempotency(
        input.patientId,
        input.idempotencyKey,
        this.now(),
      );
      if (hit) return hit as { entries: ProfileEntry[]; status: ProfileStatus };
    }
    const entries: ProfileEntry[] = [];
    for (const fieldKey of fields) {
      const value = input.answers[fieldKey];
      if (value === undefined) continue;
      const issues = validateFieldValue(fieldKey, value);
      if (issues.length > 0) {
        throw new ProfileValidationError(issues);
      }
      entries.push(await this.upsertPatientEntry(input.patientId, fieldKey, value, input.decidedVia));
    }
    if (entries.length === 0) {
      throw new ProfileValidationError([{ field: fields[0]!, issue: '本步未提交任何字段' }]);
    }
    const result = { entries, status: this.status(input.patientId) };
    if (input.idempotencyKey && this.backend.putIdempotency) {
      await this.backend.putIdempotency({
        key: input.idempotencyKey,
        tenantId: this.tenantId,
        patientId: input.patientId,
        endpoint: `profile.answers.${input.step}`,
        response: result,
        at: this.now(),
      });
    }
    return result;
  }

  /** 患者确认既有资料（「已有资料让患者确认或申请更正」） */
  async confirm(patientId: string, entryIds: string[], via: string): Promise<ProfileEntry[]> {
    const confirmed: ProfileEntry[] = [];
    for (const id of entryIds) {
      const entry = this.list(patientId).find((item) => item.id === id);
      if (!entry) continue;
      if (entry.status === 'confirmed') {
        confirmed.push(entry);
        continue;
      }
      entry.status = 'confirmed';
      entry.confirmedAt = this.now();
      entry.confirmedBy = via;
      entry.updatedAt = this.now();
      await this.backend.putProfileEntry(entry);
      confirmed.push(entry);
    }
    return confirmed;
  }

  /** 患者申请纠错：只标「待确认」，内容与来源不动（后台处理前保留原事实） */
  async markDisputed(patientId: string, entryId: string): Promise<ProfileEntry> {
    const entry = this.list(patientId).find((item) => item.id === entryId);
    if (!entry) {
      throw new ProfileValidationError([{ field: 'goal', issue: '条目不存在' }]);
    }
    if (entry.status === 'disputed') return entry;
    const updated: ProfileEntry = { ...entry, status: 'disputed', updatedAt: this.now() };
    await this.backend.putProfileEntry(updated);
    return updated;
  }

  /** 档案状态：完成度 + 安全缺失/冲突（A03：缺失或冲突阻止进入可执行建议） */
  status(patientId: string): ProfileStatus {
    const entries = this.list(patientId);
    const present = new Set(entries.map((item) => item.fieldKey));
    const completeness = present.size / PROFILE_FIELD_KEYS.length;
    const safetyMissing = !present.has('allergy');
    const conflicts: Array<{ fieldKey: ProfileFieldKey; detail: string }> = [];
    for (const fieldKey of PROFILE_FIELD_KEYS) {
      const bySource = new Map<ProfileSource, ProfileEntry>();
      for (const entry of entries.filter((item) => item.fieldKey === fieldKey)) {
        bySource.set(entry.source, entry);
      }
      const patientEntry = bySource.get('patient');
      const professionalEntry = bySource.get('professional');
      if (patientEntry && professionalEntry) {
        const same = JSON.stringify(patientEntry.value) === JSON.stringify(professionalEntry.value);
        if (!same) {
          conflicts.push({
            fieldKey,
            detail: `自述（${patientEntry.valueText}）与专业确认（${professionalEntry.valueText}）不一致，需团队核对`,
          });
        }
      }
    }
    return { completeness, safetyMissing, conflicts };
  }

  /** /me 状态聚合（PH5-03 版）：建档未完成 / 资料待补充 / 计划准备中 */
  meStatus(patientId: string, patientStatus: string): string {
    if (patientStatus !== 'serving') return 'service_paused';
    const profile = this.status(patientId);
    if (profile.safetyMissing) return 'profile_incomplete';
    if (profile.conflicts.length > 0) return 'data_pending';
    if (profile.completeness < 1) return 'profile_incomplete';
    // PH5-04 落地前：资料齐全后统一显示「正在为你准备计划」（PRD H03）
    return 'plan_generating';
  }

  private async upsertPatientEntry(
    patientId: string,
    fieldKey: ProfileFieldKey,
    value: Record<string, unknown>,
    via: string,
  ): Promise<ProfileEntry> {
    const now = this.now();
    const valueText = fieldValueText(fieldKey, value);
    const all = this.list(patientId).filter((item) => item.fieldKey === fieldKey);
    // 优先更新患者自己的条目；professional 条目永远不作为更新目标（否则并列草稿会无限累积）
    const existing = all.find((item) => item.source === 'patient') ?? all[0];

    if (existing && CONFLICT_SOURCES.has(existing.source)) {
      // 已有患者/专业条目：更新患者自己的；professional 条目保留并列（不覆盖）
      if (existing.source === 'patient') {
        existing.revisions = [...existing.revisions, { value: existing.value, source: 'patient', at: now, via }];
        existing.value = value;
        existing.valueText = valueText;
        existing.updatedAt = now;
        await this.backend.putProfileEntry(existing);
        return existing;
      }
    }

    if (existing && (existing.source === 'agent' || existing.source === 'advisor')) {
      // 顾问/Agent 录入的旧值被患者自述确认替换：保留修订历史
      existing.revisions = [
        ...existing.revisions,
        { value: existing.value, source: existing.source, at: now, via },
      ];
      existing.value = value;
      existing.valueText = valueText;
      existing.source = 'patient';
      existing.status = 'confirmed';
      existing.updatedAt = now;
      await this.backend.putProfileEntry(existing);
      return existing;
    }

    if (existing && existing.source === 'professional') {
      // 专业确认值不覆盖：并列一条 patient 草稿（待团队核对，进入 conflicts）
      const draft: ProfileEntry = {
        id: this.ids('ppe'),
        tenantId: this.tenantId,
        patientId,
        fieldKey,
        value,
        valueText,
        source: 'patient',
        status: 'draft',
        updatedAt: now,
        revisions: [],
      };
      await this.backend.putProfileEntry(draft);
      return draft;
    }

    if (existing) {
      existing.revisions = [...existing.revisions, { value: existing.value, source: existing.source, at: now, via }];
      existing.value = value;
      existing.valueText = valueText;
      existing.updatedAt = now;
      await this.backend.putProfileEntry(existing);
      return existing;
    }

    const fresh: ProfileEntry = {
      id: this.ids('ppe'),
      tenantId: this.tenantId,
      patientId,
      fieldKey,
      value,
      valueText,
      source: 'patient',
      status: 'confirmed',
      updatedAt: now,
      revisions: [],
    };
    await this.backend.putProfileEntry(fresh);
    return fresh;
  }
}

export class ProfileValidationError extends Error {
  readonly issues: ValueIssue[];

  constructor(issues: ValueIssue[]) {
    super('建档资料校验失败');
    this.name = 'ProfileValidationError';
    this.issues = issues;
  }
}

/** 内存实现（测试与域存储不可用时的退路） */
export class MemoryProfileBackend implements ProfileBackend {
  private readonly entries: ProfileEntry[] = [];
  private readonly idempotency: IdempotencyRecord[] = [];

  loadProfileEntries(): ProfileEntry[] {
    return [...this.entries];
  }

  async putProfileEntry(entry: ProfileEntry): Promise<void> {
    const index = this.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
  }

  async loadIdempotency(patientId: string, key: string, now: number): Promise<unknown> {
    const hit = this.idempotency.find(
      (item) =>
        item.patientId === patientId && item.key === key && now - item.at <= IDEMPOTENCY_WINDOW_MS,
    );
    return hit?.response;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    this.idempotency.push(record);
  }
}
