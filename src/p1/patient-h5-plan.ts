/**
 * PH5-04（#233）患者端 H5：健康方案生成、专业审核发布与版本变更。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.6、§4.2、§5；docs/PATIENT-H5-api.md §5、§12.2。
 *
 * 三条不可让步的规则（issue #233 验收）：
 * 1. 未审核不发布——患者只见 published / suspended / ended（A04）
 * 2. 同一患者至多一个 published；换版要在同一事务里让旧版失效（A05）
 * 3. 取消只向未来传播：历史事项与记录一律不改写（A05）
 *
 * AI 生成走端口注入：模型不可用或资料不全时进入 generate_failed / data_pending，
 * 保留输入快照并交团队人工接管，绝不把模板伪装成个性化方案（A03）。
 */
import type { IdFactory } from './ids.ts';
import type { ProfileService } from './patient-h5-profile.ts';

// ---------- 错误 ----------

export type PlanErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'PLAN_VERSION_CONFLICT'
  | 'IMMUTABLE_RESOURCE'
  | 'DATA_PENDING'
  | 'UPSTREAM_UNAVAILABLE'
  | 'FORBIDDEN';

export class PlanError extends Error {
  readonly code: PlanErrorCode;

  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

// ---------- 实体（契约 §3.6 / §3.7） ----------

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

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'returned';

export interface PlanAction {
  actionId: string;
  title: string;
  purpose: string;
  method: string;
  schedule: {
    kind: 'daily' | 'weekly' | 'oneoff';
    time: string;
    weekdays?: number[];
    dates?: string[];
  };
  feedbackKind: 'none' | 'checkin' | 'record_meal' | 'record_review';
  linkedArticleIds: string[];
}

export interface PlanReview {
  status: ReviewStatus;
  reviewerAccountId?: string;
  reviewerName?: string;
  reviewedAt?: number;
  note?: string;
  editedByReviewer?: boolean;
}

export interface HealthPlanRecord {
  id: string;
  tenantId: string;
  patientId: string;
  version: number;
  status: PlanStatus;
  stageGoal: string;
  startDate: string;
  endDate: string;
  foodTherapyRationale: string;
  focusPoints: string[];
  actions: PlanAction[];
  feedbackRequirements: string[];
  /** 生成时的输入快照：条目 id 与授权版本，不含自由正文 */
  inputSnapshot: {
    profileEntryIds: string[];
    memoryIds: string[];
    consentVersion?: number;
    takenAt: number;
  };
  ruleRefs: Array<{ refType: string; refId: string; refVersion: number }>;
  generation: {
    source: 'agent' | 'manual';
    model?: string;
    promptVersion?: string;
    startedAt: number;
    finishedAt?: number;
    attempts: number;
    errorCode?: string;
  };
  review: PlanReview;
  reviewHistory: Array<PlanReview & { at: number; actorId: string }>;
  effectiveFrom?: number;
  effectiveTo?: number;
  acknowledgedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type CalendarItemStatus = 'pending' | 'done' | 'missed' | 'needs_help' | 'cancelled';

export interface CalendarItemRecord {
  id: string;
  tenantId: string;
  patientId: string;
  planId: string;
  planVersion: number;
  actionId: string;
  scheduledDate: string;
  scheduledAt: number;
  title: string;
  purpose: string;
  method: string;
  feedbackKind: PlanAction['feedbackKind'];
  linkedArticleIds: string[];
  status: CalendarItemStatus;
  cancelReason?: string;
  cancelledAt?: number;
  feedback?: {
    kind: 'patient_confirmed' | 'record_matched' | 'missed' | 'needs_help';
    submittedAt: number;
    reason?: string;
  };
  createdAt: number;
}

// ---------- 生成端口 ----------

export interface PlanDraftInput {
  patientId: string;
  /** 已授权的档案条目（患者可读的键值） */
  profile: Array<{ fieldKey: string; valueText: string }>;
  /** 安全信息是否齐备（冲突或缺失时不得生成可执行方案） */
  safetyMissing: boolean;
  conflicts: string[];
  /** 起止日期由调用方给出（周期由方案决定，不固定 28 天） */
  startDate: string;
  endDate: string;
}

export interface PlanDraft {
  stageGoal: string;
  foodTherapyRationale: string;
  focusPoints: string[];
  actions: PlanAction[];
  feedbackRequirements: string[];
  ruleRefs: Array<{ refType: string; refId: string; refVersion: number }>;
  model?: string;
  promptVersion?: string;
}

export type PlanDraftResult = { ok: true; draft: PlanDraft } | { ok: false; errorCode: string };

export interface PlanGenerationPort {
  readonly configured: boolean;
  generate(input: PlanDraftInput): Promise<PlanDraftResult>;
}

/** 未接入模型时的默认端口：一律失败，交团队人工接管（不假装成功） */
export const UNCONFIGURED_GENERATOR: PlanGenerationPort = {
  configured: false,
  async generate(): Promise<PlanDraftResult> {
    return { ok: false, errorCode: 'UPSTREAM_UNAVAILABLE' };
  },
};

// ---------- 存储 ----------

export interface PlanSnapshot {
  plans: HealthPlanRecord[];
  calendarItems: CalendarItemRecord[];
}

export interface PlanBackend {
  load(): PlanSnapshot;
  putPlan(record: HealthPlanRecord): Promise<void>;
  putCalendarItem(record: CalendarItemRecord): Promise<void>;
}

export class MemoryPlanBackend implements PlanBackend {
  private readonly plans: HealthPlanRecord[] = [];
  private readonly items: CalendarItemRecord[] = [];

  load(): PlanSnapshot {
    return { plans: [...this.plans], calendarItems: [...this.items] };
  }

  async putPlan(record: HealthPlanRecord): Promise<void> {
    const index = this.plans.findIndex((item) => item.id === record.id);
    if (index >= 0) this.plans[index] = record;
    else this.plans.push(record);
  }

  async putCalendarItem(record: CalendarItemRecord): Promise<void> {
    const index = this.items.findIndex((item) => item.id === record.id);
    if (index >= 0) this.items[index] = record;
    else this.items.push(record);
  }
}

// ---------- 工具 ----------

export function localDateOf(at: number, timeZone = 'Asia/Shanghai'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

function atLocalTime(date: string, time: string): number {
  // 以本地时区解释 YYYY-MM-DD + HH:mm
  return new Date(`${date}T${time}:00`).getTime();
}

function* eachDate(startDate: string, endDate: string): Generator<string> {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= end && guard < 400) {
    guard += 1;
    yield localDateOf(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
}

// ---------- 服务 ----------

export interface PlanServiceOptions {
  tenantId: string;
  backend: PlanBackend;
  generator: PlanGenerationPort;
  profile: ProfileService;
  ids: IdFactory;
  now?: () => number;
  onAudit?: (event: {
    action: string;
    patientId: string;
    planId?: string;
    detail?: Record<string, unknown>;
  }) => void;
  /** 取消传播钩子：提醒包（PH5-09）据此撤销未发出任务 */
  onPlanEvent?: (event: {
    type: 'published' | 'suspended' | 'ended' | 'superseded';
    patientId: string;
    planId: string;
    cancelledItemIds: string[];
  }) => void;
}

export class PlanService {
  private readonly backend: PlanBackend;
  private readonly tenantId: string;
  private readonly generator: PlanGenerationPort;
  private readonly profile: ProfileService;
  private readonly ids: IdFactory;
  private readonly now: () => number;

  constructor(options: PlanServiceOptions) {
    this.backend = options.backend;
    this.tenantId = options.tenantId;
    this.generator = options.generator;
    this.profile = options.profile;
    this.ids = options.ids;
    this.now = options.now ?? Date.now;
    this.onAudit = options.onAudit;
    this.onPlanEvent = options.onPlanEvent;
  }

  private readonly onAudit?: PlanServiceOptions['onAudit'];
  private readonly onPlanEvent?: PlanServiceOptions['onPlanEvent'];

  // ---------- 查询 ----------

  list(patientId: string): HealthPlanRecord[] {
    return this.backend
      .load()
      .plans.filter((item) => item.tenantId === this.tenantId && item.patientId === patientId)
      .sort((a, b) => b.version - a.version);
  }

  get(id: string): HealthPlanRecord | undefined {
    return this.backend
      .load()
      .plans.find((item) => item.tenantId === this.tenantId && item.id === id);
  }

  /** 患者可见的当前版本（published / suspended / ended） */
  currentForPatient(patientId: string): HealthPlanRecord | undefined {
    return this.list(patientId).find(
      (item) => item.status === 'published' || item.status === 'suspended' || item.status === 'ended',
    );
  }

  listCalendarItems(patientId: string, from?: string, to?: string): CalendarItemRecord[] {
    return this.backend
      .load()
      .calendarItems.filter(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === patientId &&
          (!from || item.scheduledDate >= from) &&
          (!to || item.scheduledDate <= to),
      )
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  // ---------- 生成 ----------

  /**
   * 触发生成。资料不全或存在冲突时直接拒绝（data_pending / 422），
   * 模型不可用时保留快照并记 generate_failed，交团队人工接管。
   */
  async generate(input: {
    patientId: string;
    startDate: string;
    endDate: string;
    actorId: string;
  }): Promise<HealthPlanRecord> {
    const status = this.profile.status(input.patientId);
    const latest = this.list(input.patientId)[0];
    // 旧版仍生效时允许起草新版本（换版本就是这条路径）；
    // 只拦「已有一份待审核草稿」，避免同时挂两份待审方案。
    if (latest && (latest.status === 'reviewing' || latest.status === 'generating')) {
      throw new PlanError('CONFLICT', '已有一份待审核的方案，请先处理完再生成新版本');
    }

    const entries = this.profile.list(input.patientId);
    const snapshot = {
      profileEntryIds: entries.map((item) => item.id),
      memoryIds: [] as string[],
      takenAt: this.now(),
    };
    const now = this.now();
    const record: HealthPlanRecord = {
      id: this.ids('hpl'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      version: (latest?.version ?? 0) + 1,
      status: 'generating',
      stageGoal: '',
      startDate: input.startDate,
      endDate: input.endDate,
      foodTherapyRationale: '',
      focusPoints: [],
      actions: [],
      feedbackRequirements: [],
      inputSnapshot: snapshot,
      ruleRefs: [],
      generation: {
        source: 'agent',
        startedAt: now,
        attempts: 1,
      },
      review: { status: 'pending' },
      reviewHistory: [],
      createdAt: now,
      updatedAt: now,
    };

    // 安全信息缺失或冲突：不生成可执行方案（A03）
    if (status.safetyMissing || status.conflicts.length > 0) {
      record.status = 'data_pending';
      await this.backend.putPlan(record);
      this.audit('h5.plan.data_pending', record, input.actorId, {
        safetyMissing: status.safetyMissing,
        conflicts: status.conflicts.length,
      });
      return record;
    }

    const draftInput: PlanDraftInput = {
      patientId: input.patientId,
      profile: entries.map((item) => ({ fieldKey: item.fieldKey, valueText: item.valueText })),
      safetyMissing: status.safetyMissing,
      conflicts: status.conflicts.map((item) => item.detail),
      startDate: input.startDate,
      endDate: input.endDate,
    };

    const result = await this.generator.generate(draftInput);
    const finishedAt = this.now();
    if (!result.ok) {
      // 失败也保留资料与快照，状态可被人工接管
      record.status = 'generate_failed';
      record.generation = {
        ...record.generation,
        finishedAt,
        errorCode: result.errorCode,
      };
      await this.backend.putPlan(record);
      this.audit('h5.plan.generate_failed', record, input.actorId, {
        errorCode: result.errorCode,
      });
      return record;
    }

    record.status = 'reviewing';
    record.stageGoal = result.draft.stageGoal;
    record.foodTherapyRationale = result.draft.foodTherapyRationale;
    record.focusPoints = result.draft.focusPoints;
    record.actions = result.draft.actions;
    record.feedbackRequirements = result.draft.feedbackRequirements;
    record.ruleRefs = result.draft.ruleRefs;
    record.generation = {
      ...record.generation,
      ...(result.draft.model ? { model: result.draft.model } : {}),
      ...(result.draft.promptVersion ? { promptVersion: result.draft.promptVersion } : {}),
      finishedAt,
    };
    record.review = { status: 'pending' };
    record.updatedAt = finishedAt;
    await this.backend.putPlan(record);
    this.audit('h5.plan.generated', record, input.actorId, { version: record.version });
    return record;
  }

  /** 人工接管：直接写一份草稿（source=manual），用于模型不可用或团队自行拟定 */
  async createManualDraft(input: {
    patientId: string;
    startDate: string;
    endDate: string;
    actorId: string;
    stageGoal?: string;
  }): Promise<HealthPlanRecord> {
    const latest = this.list(input.patientId)[0];
    if (latest && (latest.status === 'reviewing' || latest.status === 'generating')) {
      throw new PlanError('CONFLICT', '已有一份待审核的方案，请先处理完再新建');
    }
    const now = this.now();
    const entries = this.profile.list(input.patientId);
    const record: HealthPlanRecord = {
      id: this.ids('hpl'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      version: (latest?.version ?? 0) + 1,
      status: 'reviewing',
      stageGoal: input.stageGoal ?? '',
      startDate: input.startDate,
      endDate: input.endDate,
      foodTherapyRationale: '',
      focusPoints: [],
      actions: [],
      feedbackRequirements: [],
      inputSnapshot: {
        profileEntryIds: entries.map((item) => item.id),
        memoryIds: [],
        takenAt: now,
      },
      ruleRefs: [],
      generation: { source: 'manual', startedAt: now, finishedAt: now, attempts: 0 },
      review: { status: 'pending' },
      reviewHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.putPlan(record);
    this.audit('h5.plan.manual_draft', record, input.actorId, { version: record.version });
    return record;
  }

  // ---------- 编辑与审核 ----------

  /** 编辑草稿：仅 data_pending / generate_failed / reviewing 可改；带版本乐观锁 */
  async update(input: {
    planId: string;
    actorId: string;
    expectedVersion: number;
    patch: Partial<
      Pick<
        HealthPlanRecord,
        | 'stageGoal'
        | 'startDate'
        | 'endDate'
        | 'foodTherapyRationale'
        | 'focusPoints'
        | 'actions'
        | 'feedbackRequirements'
      >
    >;
  }): Promise<HealthPlanRecord> {
    const record = this.requirePlan(input.planId);
    if (record.version !== input.expectedVersion) {
      throw new PlanError('PLAN_VERSION_CONFLICT', '方案已被他人修改，请刷新后重试');
    }
    if (!['data_pending', 'generate_failed', 'reviewing'].includes(record.status)) {
      throw new PlanError('IMMUTABLE_RESOURCE', '当前状态不可编辑');
    }
    Object.assign(record, input.patch);
    record.updatedAt = this.now();
    if (record.status === 'data_pending' || record.status === 'generate_failed') {
      record.status = 'reviewing';
    }
    await this.backend.putPlan(record);
    this.audit('h5.plan.updated', record, input.actorId, {
      fields: Object.keys(input.patch),
    });
    return record;
  }

  async reject(input: {
    planId: string;
    actorId: string;
    actorName: string;
    note: string;
  }): Promise<HealthPlanRecord> {
    const record = this.requirePlan(input.planId);
    if (record.status !== 'reviewing') {
      throw new PlanError('CONFLICT', '只有待审核方案可以退回');
    }
    const now = this.now();
    record.status = 'rejected';
    record.review = {
      status: 'rejected',
      reviewerAccountId: input.actorId,
      reviewerName: input.actorName,
      reviewedAt: now,
      note: input.note.slice(0, 500),
    };
    record.reviewHistory = [...record.reviewHistory, { ...record.review, at: now, actorId: input.actorId }];
    record.updatedAt = now;
    await this.backend.putPlan(record);
    this.audit('h5.plan.rejected', record, input.actorId, { version: record.version });
    return record;
  }

  /**
   * 发布。同一事务内：
   * 1) 校验审核已通过
   * 2) 置旧版 superseded 并取消其未来未反馈事项
   * 3) 生成新版日历事项
   * 并发发布会因状态检查失败而只成功一个（A05）。
   */
  async publish(input: {
    planId: string;
    actorId: string;
    actorName: string;
    note?: string;
  }): Promise<HealthPlanRecord> {
    const record = this.requirePlan(input.planId);
    if (record.status !== 'reviewing') {
      throw new PlanError('PLAN_VERSION_CONFLICT', '方案已被处理，不能重复发布');
    }
    if (record.actions.length === 0) {
      throw new PlanError('VALIDATION_FAILED', '方案没有任何行动，不能发布');
    }
    const now = this.now();
    const today = localDateOf(now);
    const cancelled: string[] = [];

    // 旧版失效 + 取消未来事项
    for (const other of this.list(record.patientId)) {
      if (other.id === record.id) continue;
      if (other.status === 'published' || other.status === 'suspended') {
        other.status = 'superseded';
        other.effectiveTo = now;
        other.updatedAt = now;
        await this.backend.putPlan(other);
        cancelled.push(...(await this.cancelFutureItems(other, 'plan_superseded', now, today)));
      }
    }

    record.status = 'published';
    record.effectiveFrom = now;
    record.review = {
      status: 'approved',
      reviewerAccountId: input.actorId,
      reviewerName: input.actorName,
      reviewedAt: now,
      ...(input.note ? { note: input.note.slice(0, 500) } : {}),
    };
    record.reviewHistory = [...record.reviewHistory, { ...record.review, at: now, actorId: input.actorId }];
    record.updatedAt = now;
    await this.backend.putPlan(record);
    await this.materializeItems(record, now);

    this.audit('h5.plan.published', record, input.actorId, {
      version: record.version,
      cancelledItems: cancelled.length,
    });
    this.onPlanEvent?.({
      type: 'published',
      patientId: record.patientId,
      planId: record.id,
      cancelledItemIds: cancelled,
    });
    return record;
  }

  async suspend(input: { planId: string; actorId: string }): Promise<HealthPlanRecord> {
    const record = this.requirePlan(input.planId);
    if (record.status !== 'published') throw new PlanError('CONFLICT', '只有执行中的方案可以暂停');
    const now = this.now();
    const cancelled = await this.cancelFutureItems(record, 'plan_suspended', now, localDateOf(now));
    record.status = 'suspended';
    record.updatedAt = now;
    await this.backend.putPlan(record);
    this.audit('h5.plan.suspended', record, input.actorId, {});
    this.onPlanEvent?.({
      type: 'suspended',
      patientId: record.patientId,
      planId: record.id,
      cancelledItemIds: cancelled,
    });
    return record;
  }

  async resume(input: { planId: string; actorId: string }): Promise<HealthPlanRecord> {
    const record = this.requirePlan(input.planId);
    if (record.status !== 'suspended') throw new PlanError('CONFLICT', '只有已暂停的方案可以恢复');
    const now = this.now();
    const today = localDateOf(now);
    record.status = 'published';
    record.updatedAt = now;
    await this.backend.putPlan(record);
    // 恢复被暂停取消的未来事项（因换版/结束取消的不动）
    for (const item of this.listCalendarItems(record.patientId)) {
      if (item.planId !== record.id) continue;
      if (item.status !== 'cancelled' || item.cancelReason !== 'plan_suspended') continue;
      if (item.scheduledDate < today) continue;
      item.status = 'pending';
      delete item.cancelReason;
      delete item.cancelledAt;
      await this.backend.putCalendarItem(item);
    }
    await this.materializeItems(record, now);
    this.audit('h5.plan.resumed', record, input.actorId, {});
    return record;
  }

  async end(input: { planId: string; actorId: string }): Promise<HealthPlanRecord> {
    const record = this.requirePlan(input.planId);
    if (record.status !== 'published' && record.status !== 'suspended') {
      throw new PlanError('CONFLICT', '当前状态不能结束');
    }
    const now = this.now();
    const cancelled = await this.cancelFutureItems(record, 'plan_ended', now, localDateOf(now));
    record.status = 'ended';
    record.effectiveTo = now;
    record.updatedAt = now;
    await this.backend.putPlan(record);
    this.audit('h5.plan.ended', record, input.actorId, {});
    this.onPlanEvent?.({
      type: 'ended',
      patientId: record.patientId,
      planId: record.id,
      cancelledItemIds: cancelled,
    });
    return record;
  }

  /** 患者「已了解计划」（不替代专业审核） */
  async acknowledge(patientId: string): Promise<HealthPlanRecord> {
    const current = this.currentForPatient(patientId);
    if (!current) throw new PlanError('NOT_FOUND', '暂无已发布方案');
    if (current.acknowledgedAt) return current;
    const now = this.now();
    current.acknowledgedAt = now;
    current.updatedAt = now;
    await this.backend.putPlan(current);
    this.audit('h5.plan.acknowledged', current, patientId, {});
    return current;
  }

  // ---------- 内部 ----------

  private requirePlan(id: string): HealthPlanRecord {
    const record = this.get(id);
    if (!record) throw new PlanError('NOT_FOUND', '方案不存在');
    return record;
  }

  /** 把行动展开成日历事项（只生成今天及以后的；历史不改写） */
  private async materializeItems(record: HealthPlanRecord, now: number): Promise<void> {
    const today = localDateOf(now);
    const existing = new Set(
      this.listCalendarItems(record.patientId).map((item) => `${item.planId}:${item.actionId}:${item.scheduledDate}`),
    );
    for (const date of eachDate(record.startDate, record.endDate)) {
      if (date < today) continue;
      for (const action of record.actions) {
        if (!this.matchesDate(action, date)) continue;
        const key = `${record.id}:${action.actionId}:${date}`;
        if (existing.has(key)) continue;
        const item: CalendarItemRecord = {
          id: this.ids('cal'),
          tenantId: this.tenantId,
          patientId: record.patientId,
          planId: record.id,
          planVersion: record.version,
          actionId: action.actionId,
          scheduledDate: date,
          scheduledAt: atLocalTime(date, action.schedule.time),
          title: action.title,
          purpose: action.purpose,
          method: action.method,
          feedbackKind: action.feedbackKind,
          linkedArticleIds: action.linkedArticleIds,
          status: 'pending',
          createdAt: now,
        };
        await this.backend.putCalendarItem(item);
      }
    }
  }

  /** 取消未来未反馈事项；已反馈与历史一律不动（A05） */
  private async cancelFutureItems(
    record: HealthPlanRecord,
    reason: 'plan_superseded' | 'plan_suspended' | 'plan_ended',
    now: number,
    today: string,
  ): Promise<string[]> {
    const cancelled: string[] = [];
    for (const item of this.listCalendarItems(record.patientId)) {
      if (item.planId !== record.id) continue;
      if (item.status !== 'pending') continue;
      if (item.scheduledDate < today) continue;
      item.status = 'cancelled';
      item.cancelReason = reason;
      item.cancelledAt = now;
      await this.backend.putCalendarItem(item);
      cancelled.push(item.id);
    }
    return cancelled;
  }

  private matchesDate(action: PlanAction, date: string): boolean {
    const schedule = action.schedule;
    if (schedule.kind === 'oneoff') {
      return Boolean(schedule.dates?.includes(date));
    }
    if (schedule.kind === 'weekly') {
      const weekday = (new Date(`${date}T00:00:00`).getDay() + 6) % 7 + 1;
      return Boolean(schedule.weekdays?.includes(weekday));
    }
    return true;
  }

  private audit(
    action: string,
    record: HealthPlanRecord,
    actorId: string,
    detail: Record<string, unknown>,
  ): void {
    this.onAudit?.({
      action,
      patientId: record.patientId,
      planId: record.id,
      detail: { version: record.version, actorId, ...detail },
    });
  }
}
