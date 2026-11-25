/**
 * PH5-09（#238）患者端 H5：提醒任务、频控、安静时段与取消传播。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.12、§4.5、§5；docs/PATIENT-H5-api.md §10、§12.6。
 *
 * 四条硬规则（issue 验收）：
 * 1. **安静时段与频控取更严格的一方**：租户默认 21:00–08:00、每天 2 次，患者偏好只能更严
 * 2. **生成与发送前都要复查状态**：换版/完成/撤回/暂停后不能再触达，哪怕任务已排队
 * 3. **六个状态各记各的**：已生成 / 待顾问处理 / 已发出 / 已核验 / 发送失败 / 已取消；
 *    系统发出 ≠ 患者已读 ≠ 行动完成
 * 4. **重启去重、不密集补发**：同一天同类提醒只保留一条，过期普通提醒不再补发
 */
import type { IdFactory } from './ids.ts';
import type { CalendarItemRecord } from './patient-h5-plan.ts';

export type ReminderKind = 'item_reminder' | 'gentle_inquiry' | 'plan_notice';

export type ReminderStatus =
  | 'generated'
  | 'advisor_pending'
  | 'sent'
  | 'verified'
  | 'send_failed'
  | 'cancelled';

export type CancelReason =
  | 'plan_superseded'
  | 'plan_suspended'
  | 'plan_ended'
  | 'team_cancelled'
  | 'service_stopped'
  | 'freq_capped'
  | 'pref_off'
  | 'consent_withdrawn';

export interface ReminderRecord {
  id: string;
  tenantId: string;
  patientId: string;
  calendarItemId?: string;
  kind: ReminderKind;
  message: string;
  localDate: string;
  /** 频控键：同一患者同一天共用 */
  freqKey: string;
  scheduledAt: number;
  status: ReminderStatus;
  quietHoursShifted: boolean;
  draftId?: string;
  deliveryId?: string;
  verificationId?: string;
  sentAt?: number;
  verifiedAt?: number;
  errorCode?: string;
  cancelReason?: CancelReason;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReminderBackend {
  load(): ReminderRecord[];
  put(record: ReminderRecord): Promise<void>;
}

export class MemoryReminderBackend implements ReminderBackend {
  private readonly records: ReminderRecord[] = [];

  load(): ReminderRecord[] {
    return [...this.records];
  }

  async put(record: ReminderRecord): Promise<void> {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface PatientReminderPrefs {
  enabled: boolean;
  dailyLimit?: number;
  quietHours?: QuietHours;
  gentleInquiry?: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: '21:00', end: '08:00' };
export const DEFAULT_DAILY_LIMIT = 2;

export interface ReminderServiceOptions {
  tenantId: string;
  backend: ReminderBackend;
  ids: IdFactory;
  now?: () => number;
  timeZone?: string;
  tenantQuietHours?: QuietHours;
  tenantDailyLimit?: number;
  /** 患者偏好读取：未实现时按租户默认 */
  prefsOf?: (patientId: string) => PatientReminderPrefs | undefined;
  /** 读取事项与方案状态，用于生成与发送前复查 */
  loadItems: (patientId: string) => CalendarItemRecord[];
  loadPlanStatus: (patientId: string) => string | undefined;
  onAudit?: (event: { action: string; patientId: string; detail?: Record<string, unknown> }) => void;
}

function localDateOf(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

function toMinutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

/** 取两个安静时段中更严格（更长）的一个 */
export function stricterQuietHours(a: QuietHours, b?: QuietHours): QuietHours {
  if (!b) return a;
  const span = (window: QuietHours): number => {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    return end > start ? end - start : 24 * 60 - start + end;
  };
  return span(b) >= span(a) ? b : a;
}

/** 时刻是否落在安静时段内（支持跨零点） */
export function inQuietHours(at: number, window: QuietHours, timeZone: string): boolean {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at));
  const minutes = toMinutes(text);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** 顺延到安静时段结束后的第一个整点 */
export function shiftOutOfQuietHours(
  at: number,
  window: QuietHours,
  timeZone: string,
): number {
  if (!inQuietHours(at, window, timeZone)) return at;
  const endMinutes = toMinutes(window.end);
  const cursor = new Date(at);
  // 最多尝试两天，避免异常配置导致死循环
  for (let index = 0; index < 2 * 24 * 60; index += 1) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (!inQuietHours(cursor.getTime(), window, timeZone)) {
      // 取整到分钟即可（逐分钟推进已足够精确）
      return cursor.getTime();
    }
  }
  void endMinutes;
  return at;
}

export class ReminderService {
  private readonly tenantId: string;
  private readonly backend: ReminderBackend;
  private readonly ids: IdFactory;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly tenantQuietHours: QuietHours;
  private readonly tenantDailyLimit: number;
  private readonly prefsOf?: (patientId: string) => PatientReminderPrefs | undefined;
  private readonly loadItems: (patientId: string) => CalendarItemRecord[];
  private readonly loadPlanStatus: (patientId: string) => string | undefined;
  private readonly onAudit?: ReminderServiceOptions['onAudit'];

  constructor(options: ReminderServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.ids = options.ids;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? 'Asia/Shanghai';
    this.tenantQuietHours = options.tenantQuietHours ?? DEFAULT_QUIET_HOURS;
    this.tenantDailyLimit = options.tenantDailyLimit ?? DEFAULT_DAILY_LIMIT;
    this.prefsOf = options.prefsOf;
    this.loadItems = options.loadItems;
    this.loadPlanStatus = options.loadPlanStatus;
    this.onAudit = options.onAudit;
  }

  list(query: { patientId?: string; status?: ReminderStatus; date?: string } = {}): ReminderRecord[] {
    return this.backend
      .load()
      .filter((item) => item.tenantId === this.tenantId)
      .filter((item) => (query.patientId ? item.patientId === query.patientId : true))
      .filter((item) => (query.status ? item.status === query.status : true))
      .filter((item) => (query.date ? item.localDate === query.date : true))
      .sort((a, b) => b.scheduledAt - a.scheduledAt);
  }

  /** 当日频控用量（已取消的不计入） */
  usage(patientId: string, date = localDateOf(this.now(), this.timeZone)): {
    used: number;
    limit: number;
  } {
    const used = this.backend
      .load()
      .filter(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === patientId &&
          item.localDate === date &&
          item.status !== 'cancelled',
      ).length;
    return { used, limit: this.limitFor(patientId) };
  }

  /**
   * 生成提醒。只处理「已发布且未取消」的事项；
   * 同一事项同一天只生成一次（重启去重）。
   */
  async generateForPatient(patientId: string, options: { horizonMinutes?: number } = {}): Promise<ReminderRecord[]> {
    const prefs = this.prefsOf?.(patientId);
    if (prefs && !prefs.enabled) return [];
    if (this.loadPlanStatus(patientId) !== 'published') return [];

    const now = this.now();
    const horizon = now + (options.horizonMinutes ?? 15) * 60 * 1000;
    const today = localDateOf(now, this.timeZone);
    const quiet = this.quietFor(patientId);
    const created: ReminderRecord[] = [];

    for (const item of this.loadItems(patientId)) {
      if (item.status !== 'pending') continue;
      if (item.scheduledAt < now || item.scheduledAt > horizon) continue;
      if (this.alreadyReminded(patientId, item, today)) continue;
      if (!this.hasCapacity(patientId, today)) break;

      const shifted = shiftOutOfQuietHours(item.scheduledAt, quiet, this.timeZone);
      const record = this.build({
        patientId,
        kind: 'item_reminder',
        message: `${item.title}：${item.purpose}`,
        scheduledAt: shifted,
        localDate: today,
        quietHoursShifted: shifted !== item.scheduledAt,
        ...(item.id ? { calendarItemId: item.id } : {}),
      });
      await this.backend.put(record);
      created.push(record);
    }
    return created;
  }

  /**
   * 当日温和询问：每天至多一次，计入同一上限；
   * 连续两天无反馈交给团队待办（由调用方根据返回值处理）。
   */
  async gentleInquiry(patientId: string, options: { afterHour?: number } = {}): Promise<ReminderRecord | null> {
    const prefs = this.prefsOf?.(patientId);
    if (prefs?.gentleInquiry === false) return null;
    if (prefs && !prefs.enabled) return null;
    if (this.loadPlanStatus(patientId) !== 'published') return null;

    const now = this.now();
    const today = localDateOf(now, this.timeZone);
    const localHour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: this.timeZone, hour: '2-digit', hour12: false }).format(
        new Date(now),
      ),
    );
    if (localHour < (options.afterHour ?? 20)) return null;

    const existing = this.backend
      .load()
      .some(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === patientId &&
          item.localDate === today &&
          item.kind === 'gentle_inquiry' &&
          item.status !== 'cancelled',
      );
    if (existing) return null;
    if (!this.hasCapacity(patientId, today)) return null;

    const quiet = this.quietFor(patientId);
    const record = this.build({
      patientId,
      kind: 'gentle_inquiry',
      message: '今天的事项还没记录，方便的话回一句感受就好。',
      scheduledAt: shiftOutOfQuietHours(now, quiet, this.timeZone),
      localDate: today,
      quietHoursShifted: false,
    });
    await this.backend.put(record);
    return record;
  }

  /** 顾问接收：生成 → 待顾问处理 */
  async enqueue(id: string): Promise<ReminderRecord> {
    const record = this.require(id);
    if (record.status !== 'generated') return record;
    record.status = 'advisor_pending';
    record.updatedAt = this.now();
    await this.backend.put(record);
    return record;
  }

  /**
   * 发出前复查：方案仍是 published、事项仍在、患者仍启用提醒。
   * 任一不满足就取消，不触达（A02）。
   */
  async markSent(input: {
    id: string;
    draftId?: string;
  }): Promise<ReminderRecord> {
    const record = this.require(input.id);
    if (record.status !== 'advisor_pending') {
      throw new Error(`提醒当前状态不可发送：${record.status}`);
    }
    const blocked = this.checkStillValid(record);
    if (blocked) {
      await this.cancel(record.id, blocked);
      const cancelled = this.require(record.id);
      throw new Error(`提醒已取消：${cancelled.cancelReason}`);
    }
    record.status = 'sent';
    record.sentAt = this.now();
    record.updatedAt = record.sentAt;
    if (input.draftId) record.draftId = input.draftId;
    await this.backend.put(record);
    this.onAudit?.({ action: 'h5.reminder.sent', patientId: record.patientId, detail: { id: record.id } });
    return record;
  }

  /** 回读核验通过——只代表消息确实发出，不代表患者已读或已完成 */
  async markVerified(id: string, verificationId?: string): Promise<ReminderRecord> {
    const record = this.require(id);
    if (record.status !== 'sent') return record;
    record.status = 'verified';
    record.verifiedAt = this.now();
    record.updatedAt = record.verifiedAt;
    if (verificationId) record.verificationId = verificationId;
    await this.backend.put(record);
    return record;
  }

  async markFailed(id: string, errorCode: string): Promise<ReminderRecord> {
    const record = this.require(id);
    if (record.status === 'cancelled' || record.status === 'verified') return record;
    record.status = 'send_failed';
    record.errorCode = errorCode;
    record.updatedAt = this.now();
    await this.backend.put(record);
    return record;
  }

  async cancel(id: string, reason: CancelReason): Promise<ReminderRecord> {
    const record = this.require(id);
    if (record.status === 'cancelled' || record.status === 'verified') return record;
    record.status = 'cancelled';
    record.cancelReason = reason;
    record.cancelledAt = this.now();
    record.updatedAt = record.cancelledAt;
    await this.backend.put(record);
    this.onAudit?.({ action: 'h5.reminder.cancel', patientId: record.patientId, detail: { reason } });
    return record;
  }

  /** 方案事件触发的批量取消（换版/暂停/结束/撤回） */
  async cancelForPlan(
    patientId: string,
    options: { planId?: string; reason: CancelReason; itemIds?: string[] },
  ): Promise<number> {
    let count = 0;
    for (const record of this.backend.load()) {
      if (record.tenantId !== this.tenantId || record.patientId !== patientId) continue;
      if (record.status === 'cancelled' || record.status === 'verified') continue;
      const matchesItem =
        options.itemIds === undefined ||
        (record.calendarItemId ? options.itemIds.includes(record.calendarItemId) : false);
      if (!matchesItem) continue;
      await this.cancel(record.id, options.reason);
      count += 1;
    }
    return count;
  }

  /** 每日上限：租户与患者偏好取更严格的一个 */
  private limitFor(patientId: string): number {
    const prefs = this.prefsOf?.(patientId);
    const limit = prefs?.dailyLimit;
    if (typeof limit === 'number' && limit >= 0) return Math.min(limit, this.tenantDailyLimit);
    return this.tenantDailyLimit;
  }

  private quietFor(patientId: string): QuietHours {
    const prefs = this.prefsOf?.(patientId);
    return stricterQuietHours(this.tenantQuietHours, prefs?.quietHours);
  }

  private hasCapacity(patientId: string, date: string): boolean {
    const { used, limit } = this.usage(patientId, date);
    return used < limit;
  }

  private alreadyReminded(patientId: string, item: CalendarItemRecord, date: string): boolean {
    return this.backend
      .load()
      .some(
        (record) =>
          record.tenantId === this.tenantId &&
          record.patientId === patientId &&
          record.localDate === date &&
          record.kind === 'item_reminder' &&
          record.calendarItemId === item.id &&
          record.status !== 'cancelled',
      );
  }

  private checkStillValid(record: ReminderRecord): CancelReason | null {
    const prefs = this.prefsOf?.(record.patientId);
    if (prefs && !prefs.enabled) return 'pref_off';
    if (this.loadPlanStatus(record.patientId) !== 'published') return 'plan_suspended';
    if (record.calendarItemId) {
      const item = this.loadItems(record.patientId).find((entry) => entry.id === record.calendarItemId);
      if (!item) return 'plan_superseded';
      if (item.status === 'cancelled') return 'plan_superseded';
      if (item.status === 'done' || item.status === 'missed' || item.status === 'needs_help') {
        return 'team_cancelled';
      }
    }
    return null;
  }

  private build(input: {
    patientId: string;
    kind: ReminderKind;
    message: string;
    scheduledAt: number;
    localDate: string;
    quietHoursShifted: boolean;
    calendarItemId?: string;
  }): ReminderRecord {
    const now = this.now();
    return {
      id: this.ids('rmd'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      ...(input.calendarItemId ? { calendarItemId: input.calendarItemId } : {}),
      kind: input.kind,
      message: input.message.slice(0, 500),
      localDate: input.localDate,
      freqKey: `${input.patientId}:${input.localDate}`,
      scheduledAt: input.scheduledAt,
      status: 'generated',
      quietHoursShifted: input.quietHoursShifted,
      createdAt: now,
      updatedAt: now,
    };
  }

  private require(id: string): ReminderRecord {
    const found = this.backend
      .load()
      .find((item) => item.tenantId === this.tenantId && item.id === id);
    if (!found) throw new Error('提醒不存在');
    return JSON.parse(JSON.stringify(found)) as ReminderRecord;
  }
}
