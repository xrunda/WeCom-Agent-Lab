/**
 * PH5-05（#234）患者端 H5：今日聚合、健康周历与行动反馈。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.7、§4.3；docs/PATIENT-H5-api.md §6。
 *
 * 四条容易做错的规则（issue 验收）：
 * 1. 进度只统计**当天已发布计划**的行动；自由记录不进分母
 * 2. 查看、收到提醒、访问页面**都不算完成**；只有明确确认或记录满足要求才算
 * 3. 未来事项不能提前完成；历史补记要区分发生时间与提交时间
 * 4. 「到期未反馈」是待跟进标记，**不是**「未执行」
 */
import type { IdFactory } from './ids.ts';
import type { CalendarItemRecord, PlanBackend, PlanService } from './patient-h5-plan.ts';

export type FeedbackKind = 'patient_confirmed' | 'missed' | 'needs_help';

export interface CalendarItemView {
  id: string;
  title: string;
  purpose: string;
  method: string;
  scheduledAt: number;
  scheduledDate: string;
  status: CalendarItemRecord['status'];
  feedbackKind: CalendarItemRecord['feedbackKind'];
  overdue: boolean;
  cancelReason: string | null;
  canFeedback: boolean;
}

export interface DayView {
  date: string;
  items: CalendarItemView[];
}

export interface TodayView {
  date: string;
  nextItem: CalendarItemView | null;
  /** 当天全部事项（按时间升序），今日页时间轴用 */
  items: CalendarItemView[];
  progress: { done: number; missed: number; needsHelp: number; pending: number; total: number };
  quickRecord: { meal: boolean; review: boolean };
  allDone: boolean;
}

export class CalendarError extends Error {
  readonly code: 'NOT_FOUND' | 'ITEM_NOT_MODIFIABLE' | 'VALIDATION_FAILED' | 'SERVICE_PAUSED';

  constructor(code: CalendarError['code'], message: string) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

/** 跟进请求最小写入（PH5-07 接管完整处理流程） */
export interface FollowupWriter {
  put(record: {
    id: string;
    tenantId: string;
    patientId: string;
    kind: 'need_help';
    message: string;
    linkedCalendarItemId: string;
    riskLevel: 'low' | 'medium';
    status: 'pending';
    createdAt: number;
    updatedAt: number;
  }): Promise<void>;
}

export interface CalendarServiceOptions {
  tenantId: string;
  plan: PlanService;
  backend: PlanBackend;
  followups: FollowupWriter;
  ids: IdFactory;
  now?: () => number;
  timeZone?: string;
}

function localDateOf(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

function startOfWeek(date: string): string {
  const base = new Date(`${date}T00:00:00`);
  const weekday = (base.getDay() + 6) % 7; // 周一为 0
  base.setDate(base.getDate() - weekday);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(
    base.getDate(),
  ).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00`);
  base.setDate(base.getDate() + days);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(
    base.getDate(),
  ).padStart(2, '0')}`;
}

export class CalendarService {
  private readonly tenantId: string;
  private readonly plan: PlanService;
  private readonly backend: PlanBackend;
  private readonly followups: FollowupWriter;
  private readonly ids: IdFactory;
  private readonly now: () => number;
  private readonly timeZone: string;

  constructor(options: CalendarServiceOptions) {
    this.tenantId = options.tenantId;
    this.plan = options.plan;
    this.backend = options.backend;
    this.followups = options.followups;
    this.ids = options.ids;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? 'Asia/Shanghai';
  }

  today(patientId: string): TodayView {
    const now = this.now();
    const today = localDateOf(now, this.timeZone);
    const items = this.itemsOn(patientId, today);
    const progress = {
      done: items.filter((item) => item.status === 'done').length,
      missed: items.filter((item) => item.status === 'missed').length,
      needsHelp: items.filter((item) => item.status === 'needs_help').length,
      pending: items.filter((item) => item.status === 'pending').length,
      total: items.filter((item) => item.status !== 'cancelled').length,
    };
    // 下一项：优先「还没到点」里最近的一条；都过点了就取最晚的一条。
    // 不能退回最早的一条——晚上九点看到「下一件小事：06:30 固定起床」会让人以为页面错了。
    const pendingItems = items.filter((item) => item.status === 'pending');
    const upcoming = pendingItems
      .filter((item) => item.scheduledAt >= now)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
    const latestPast = [...pendingItems].sort((a, b) => b.scheduledAt - a.scheduledAt)[0];
    const next = upcoming ?? latestPast ?? null;
    return {
      date: today,
      nextItem: next ? this.view(next, today) : null,
      items: items
        .filter((item) => item.status !== 'cancelled')
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
        .map((item) => this.view(item, today)),
      progress,
      quickRecord: { meal: true, review: true },
      allDone: progress.total > 0 && progress.pending === 0,
    };
  }

  /** 周视图：默认本周（周一起），可指定 from/to 或单日 */
  week(patientId: string, options: { date?: string; from?: string; to?: string } = {}): DayView[] {
    const today = localDateOf(this.now(), this.timeZone);
    const anchor = options.date ?? today;
    const from = options.from ?? startOfWeek(anchor);
    const to = options.to ?? addDays(from, 6);
    const days: DayView[] = [];
    let cursor = from;
    let guard = 0;
    while (cursor <= to && guard < 62) {
      guard += 1;
      days.push({
        date: cursor,
        items: this.itemsOn(patientId, cursor).map((item) => this.view(item, today)),
      });
      cursor = addDays(cursor, 1);
    }
    return days;
  }

  item(patientId: string, itemId: string): CalendarItemView {
    const record = this.findItem(patientId, itemId);
    if (!record) throw new CalendarError('NOT_FOUND', '事项不存在');
    return this.view(record, localDateOf(this.now(), this.timeZone));
  }

  /**
   * 提交反馈。规则：
   * - 未来事项不能提前完成（含补记例外：occurredAt 只能是过去）
   * - 已取消事项不可反馈
   * - 计划暂停时只读
   * - 需要帮助会生成跟进请求
   */
  async feedback(input: {
    patientId: string;
    itemId: string;
    kind: FeedbackKind;
    reason?: string;
    occurredAt?: number;
  }): Promise<CalendarItemView> {
    const now = this.now();
    const today = localDateOf(now, this.timeZone);
    const record = this.findItem(input.patientId, input.itemId);
    if (!record) throw new CalendarError('NOT_FOUND', '事项不存在');
    // 计划暂停/结束时先给统一口径，避免把「暂停」说成「已取消」
    const plan = this.plan.get(record.planId);
    if (!plan) throw new CalendarError('NOT_FOUND', '方案不存在');
    if (plan.status === 'suspended') {
      throw new CalendarError('SERVICE_PAUSED', '计划当前暂停中，暂不能反馈');
    }
    if (plan.status !== 'published') {
      // 换版/结束后旧版事项一律视为已取消，不再接受反馈
      throw new CalendarError('ITEM_NOT_MODIFIABLE', '该事项所属方案已不生效，不能再反馈');
    }
    if (record.status === 'cancelled') {
      throw new CalendarError('ITEM_NOT_MODIFIABLE', '该事项已取消，不能再反馈');
    }
    if (record.scheduledDate > today) {
      throw new CalendarError('ITEM_NOT_MODIFIABLE', '还没到这一天，不能提前确认');
    }
    if (input.occurredAt !== undefined && input.occurredAt > now) {
      throw new CalendarError('VALIDATION_FAILED', '发生时间不能晚于现在');
    }

    const previous = record.feedback
      ? { ...record.feedback }
      : undefined;
    record.status =
      input.kind === 'patient_confirmed' ? 'done' : input.kind === 'missed' ? 'missed' : 'needs_help';
    record.feedback = {
      kind: input.kind,
      submittedAt: now,
      ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
      ...(previous ? { previous } : {}),
    } as CalendarItemRecord['feedback'];
    await this.backend.putCalendarItem(record);

    if (input.kind === 'needs_help') {
      await this.followups.put({
        id: this.ids('fup'),
        tenantId: this.tenantId,
        patientId: input.patientId,
        kind: 'need_help',
        message: `${record.title}：${(input.reason ?? '需要帮助').slice(0, 200)}`,
        linkedCalendarItemId: record.id,
        riskLevel: 'low',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
    return this.view(record, today);
  }

  /**
   * 记录满足事项要求时回填完成（A06）。
   * 只接受 pending 且 feedbackKind 匹配的事项；已反馈/已取消一律不动。
   */
  async matchRecord(input: {
    patientId: string;
    itemId: string;
    recordId: string;
    at: number;
  }): Promise<boolean> {
    const record = this.findItem(input.patientId, input.itemId);
    if (!record) return false;
    if (record.status !== 'pending') return false;
    if (record.feedbackKind === 'none') return false;
    record.status = 'done';
    record.feedback = { kind: 'record_matched', submittedAt: input.at };
    await this.backend.putCalendarItem(record);
    return true;
  }

  // ---------- 内部 ----------

  private itemsOn(patientId: string, date: string): CalendarItemRecord[] {
    return this.plan
      .listCalendarItems(patientId, date, date)
      .filter((item) => item.tenantId === this.tenantId);
  }

  private findItem(patientId: string, itemId: string): CalendarItemRecord | undefined {
    const found = this.backend
      .load()
      .calendarItems.find(
        (item) => item.tenantId === this.tenantId && item.patientId === patientId && item.id === itemId,
      );
    return found ? (JSON.parse(JSON.stringify(found)) as CalendarItemRecord) : undefined;
  }

  private view(record: CalendarItemRecord, today: string): CalendarItemView {
    const overdue = record.scheduledDate < today && record.status === 'pending';
    return {
      id: record.id,
      title: record.title,
      purpose: record.purpose,
      method: record.method,
      scheduledAt: record.scheduledAt,
      scheduledDate: record.scheduledDate,
      status: record.status,
      feedbackKind: record.feedbackKind,
      // 到期未反馈只是待跟进标记，不等于未执行
      overdue,
      cancelReason: record.cancelReason ?? null,
      canFeedback:
        record.status !== 'cancelled' &&
        record.scheduledDate <= today &&
        record.status !== 'done',
    };
  }
}
