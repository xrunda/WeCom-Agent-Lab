/**
 * #36 主动计划：计划存储、安静时段顺延、到期触发。
 *
 * DSH 0.2.1-rc.5 的 `ctx.schedule` 是 Host 级的「把提醒投递进指定 Session
 * 并激活它」，插件侧拿不到到期回调，也无法把「哪条 care_plan 触发了」
 * 关联回业务实体。因此本包自建调度器（at / 一次性），接口语义与
 * docs/P1-data-model.md 的 care_plan 对齐；存储落在 zhiban_care 领域，
 * 重启后按 `when` 继续触发。
 *
 * 限流与优先级不在这里：真正入队前由 PatientAgentRuntime 按顾问统计，
 * 患者提问优先，主动草稿每小时最多 N 条，超出时返回 retryAt 由这里顺延。
 */
import { idFactory } from './ids.ts';
import type { IdFactory } from './ids.ts';
import type { AuditEvent } from '../c2/types.ts';

export type CarePlanStatus = 'pending' | 'done' | 'cancelled';
export type CarePlanSource = 'agent' | 'staff';

export interface CarePlanRecord {
  id: string;
  tenantId: string;
  patientId: string;
  title: string;
  /** 实际触发时间（已按安静时段顺延） */
  when: number;
  /** RFC 5545；P1 只支持一次性计划，非空时创建会被拒绝 */
  rrule?: string;
  source: CarePlanSource;
  status: CarePlanStatus;
  quietHoursShifted: boolean;
  lastFiredAt?: number;
  createdAt: number;
  updatedAt: number;
  sandbox: boolean;
}

export interface CarePlanCreateInput {
  patientId: string;
  title: string;
  when: number;
  rrule?: string | null;
  source: CarePlanSource;
}

export interface CareBackend {
  load(): CarePlanRecord[];
  put(record: CarePlanRecord): Promise<void>;
}

export interface QuietHours {
  /** 开始禁推的小时（含），默认 21 */
  start: number;
  /** 恢复推送的小时（含），默认 8 */
  end: number;
}

export interface CareServiceOptions {
  tenantId: string;
  backend: CareBackend;
  timeZone?: string;
  quietHours?: QuietHours;
  sandbox?: boolean;
  now?: () => number;
  newId?: IdFactory;
  emit?: (type: string, data: unknown) => void;
  onPersistError?: (error: Error) => void;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  onAudit?: (event: AuditEvent) => void;
}

export type CareErrorCode =
  | 'EMPTY_TITLE'
  | 'TITLE_TOO_LONG'
  | 'WHEN_NOT_FUTURE'
  | 'WHEN_INVALID'
  | 'RRULE_UNSUPPORTED'
  | 'NOT_FOUND'
  | 'IMMUTABLE_RESOURCE';

export class CareError extends Error {
  readonly code: CareErrorCode;

  constructor(code: CareErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CareError';
    this.code = code;
  }
}

export const CARE_TITLE_MAX = 120;

// ---------- 时区 ----------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export function localPartsAt(at: number, timeZone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function offsetAt(at: number, timeZone: string): number {
  const parts = localPartsAt(at, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at
  );
}

/** 把某个时区的墙上时间换回时间戳；DST 用二次校正 */
export function zonedTimeToEpoch(parts: LocalParts, timeZone: string): number {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}

/** 安静时段（默认 21:00–08:00）：到点落在禁推区间时顺延到结束时刻 */
export function shiftForQuietHours(
  at: number,
  timeZone: string,
  quiet: QuietHours,
): { when: number; shifted: boolean } {
  const parts = localPartsAt(at, timeZone);
  const inQuiet = parts.hour >= quiet.start || parts.hour < quiet.end;
  if (!inQuiet) return { when: at, shifted: false };

  let target: LocalParts;
  if (parts.hour < quiet.end) {
    target = { ...parts, hour: quiet.end, minute: 0, second: 0 };
  } else {
    const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    target = {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: quiet.end,
      minute: 0,
      second: 0,
    };
  }
  return { when: zonedTimeToEpoch(target, timeZone), shifted: true };
}

// ---------- 服务 ----------

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CareError('EMPTY_TITLE', 'title 不能为空');
  }
  const title = value.trim();
  if (title.length > CARE_TITLE_MAX) {
    throw new CareError('TITLE_TOO_LONG', `title 不能超过 ${CARE_TITLE_MAX} 字`);
  }
  return title;
}

function normalizeWhen(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CareError('WHEN_INVALID', 'when 必须是毫秒时间戳');
  }
  if (value <= now) {
    throw new CareError('WHEN_NOT_FUTURE', 'when 不能早于当前时间');
  }
  return Math.round(value);
}

export class CareService {
  private readonly tenantId: string;
  private readonly backend: CareBackend;
  private readonly timeZone: string;
  private readonly quietHours: QuietHours;
  private readonly sandbox: boolean;
  private readonly now: () => number;
  private readonly makeId: IdFactory;
  private readonly emit: (type: string, data: unknown) => void;
  private readonly onPersistError?: (error: Error) => void;
  private readonly schedule: (fn: () => void, delayMs: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private readonly onAudit?: (event: AuditEvent) => void;

  private readonly plans = new Map<string, CarePlanRecord>();
  private readonly auditLog: AuditEvent[] = [];
  private chain: Promise<void> = Promise.resolve();

  private timer?: unknown;
  private handler?: (plan: CarePlanRecord) => Promise<void>;
  private firing = false;
  private stopped = true;

  constructor(options: CareServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.timeZone = options.timeZone ?? 'Asia/Shanghai';
    this.quietHours = options.quietHours ?? { start: 21, end: 8 };
    this.sandbox = options.sandbox ?? false;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.newId ?? idFactory(this.now);
    this.emit = options.emit ?? (() => undefined);
    this.onPersistError = options.onPersistError;
    this.schedule =
      options.schedule ??
      ((fn, delayMs) => {
        const handle = setTimeout(fn, delayMs);
        handle.unref?.();
        return handle;
      });
    this.cancelSchedule =
      options.cancelSchedule ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onAudit = options.onAudit;
    for (const plan of options.backend.load()) this.plans.set(plan.id, plan);
  }

  /** 注册到期处理并启动定时器；插件加载后调用 */
  start(handler: (plan: CarePlanRecord) => Promise<void>): void {
    this.handler = handler;
    this.stopped = false;
    this.arm();
  }

  dispose(): void {
    this.stopped = true;
    this.handler = undefined;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
  }

  create(input: CarePlanCreateInput): CarePlanRecord {
    const title = normalizeTitle(input.title);
    const at = this.normalizeFutureWhen(input.when);
    if (input.rrule !== undefined && input.rrule !== null && String(input.rrule).trim() !== '') {
      throw new CareError('RRULE_UNSUPPORTED', 'P1 只支持一次性计划，rrule 暂不支持');
    }
    const createdAt = this.now();
    const plan: CarePlanRecord = {
      id: this.makeId('pln'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      title,
      when: at.when,
      source: input.source,
      status: 'pending',
      quietHoursShifted: at.shifted,
      createdAt,
      updatedAt: createdAt,
      sandbox: this.sandbox,
    };
    this.plans.set(plan.id, plan);
    this.persist(plan);
    this.audit(input.source === 'staff' ? 'staff' : 'agent', 'care_plan.create', plan.id, 'ok');
    this.emit('care_plan.created', {
      planId: plan.id,
      patientId: plan.patientId,
      status: plan.status,
      when: plan.when,
      source: plan.source,
    });
    this.arm();
    return plan;
  }

  cancel(id: string, actor: 'agent' | 'staff' = 'staff'): CarePlanRecord {
    const plan = this.get(id);
    if (!plan) throw new CareError('NOT_FOUND', `计划 ${id} 不存在`);
    if (plan.status === 'done') {
      throw new CareError('IMMUTABLE_RESOURCE', '已执行的计划不能取消');
    }
    if (plan.status === 'cancelled') return plan;
    const updated: CarePlanRecord = {
      ...plan,
      status: 'cancelled',
      updatedAt: this.now(),
    };
    this.plans.set(id, updated);
    this.persist(updated);
    this.audit(actor, 'care_plan.cancel', id, 'ok');
    this.emit('care_plan.cancelled', {
      planId: id,
      patientId: plan.patientId,
      status: 'cancelled',
      when: plan.when,
    });
    this.arm();
    return updated;
  }

  /** 到期处理失败 / 限流顺延时调用：改时间并保持 pending */
  defer(id: string, when: number, reason: string): CarePlanRecord {
    const plan = this.get(id);
    if (!plan) throw new CareError('NOT_FOUND', `计划 ${id} 不存在`);
    const shifted = shiftForQuietHours(Math.max(when, this.now() + 1_000), this.timeZone, this.quietHours);
    const updated: CarePlanRecord = {
      ...plan,
      when: shifted.when,
      quietHoursShifted: plan.quietHoursShifted || shifted.shifted,
      updatedAt: this.now(),
    };
    this.plans.set(id, updated);
    this.persist(updated);
    this.audit('system', 'care_plan.defer', id, reason);
    this.emit('care_plan.deferred', {
      planId: id,
      patientId: plan.patientId,
      when: updated.when,
      reason,
    });
    this.arm();
    return updated;
  }

  markDone(id: string): CarePlanRecord {
    const plan = this.get(id);
    if (!plan) throw new CareError('NOT_FOUND', `计划 ${id} 不存在`);
    const at = this.now();
    const updated: CarePlanRecord = {
      ...plan,
      status: 'done',
      lastFiredAt: at,
      updatedAt: at,
    };
    this.plans.set(id, updated);
    this.persist(updated);
    this.audit('system', 'care_plan.fire', id, 'ok');
    this.emit('care_plan.fired', {
      planId: id,
      patientId: plan.patientId,
      status: 'done',
      when: plan.when,
    });
    this.arm();
    return updated;
  }

  get(id: string): CarePlanRecord | undefined {
    return this.plans.get(id);
  }

  list(patientId?: string, status?: CarePlanStatus): CarePlanRecord[] {
    return [...this.plans.values()]
      .filter((plan) => (patientId ? plan.patientId === patientId : true))
      .filter((plan) => (status ? plan.status === status : true))
      .sort((a, b) => a.when - b.when);
  }

  /** 到期但还没处理的计划，按 when 升序；测试与定时器都用它 */
  due(at = this.now()): CarePlanRecord[] {
    return this.list(undefined, 'pending').filter((plan) => plan.when <= at);
  }

  /** 立即处理所有到期计划；同一时刻只跑一轮，避免定时器与手动触发重入 */
  async fireDue(): Promise<number> {
    if (this.firing || this.stopped || !this.handler) return 0;
    this.firing = true;
    let fired = 0;
    try {
      for (const plan of this.due()) {
        if (this.plans.get(plan.id)?.status !== 'pending') continue;
        try {
          await this.handler(plan);
          fired += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.audit('system', 'care_plan.fire', plan.id, 'failed', message);
          this.emit('care_plan.failed', {
            planId: plan.id,
            patientId: plan.patientId,
            message,
          });
        }
      }
    } finally {
      this.firing = false;
      this.arm();
    }
    return fired;
  }

  audits(): AuditEvent[] {
    return [...this.auditLog];
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private normalizeFutureWhen(
    value: number,
  ): { when: number; shifted: boolean } {
    const when = normalizeWhen(value, this.now());
    return shiftForQuietHours(when, this.timeZone, this.quietHours);
  }

  /** 单一定时器指向最近一条 pending 计划 */
  private arm(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    const next = this.list(undefined, 'pending')[0];
    if (!next) return;
    const delay = Math.max(0, next.when - this.now());
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.fireDue();
    }, delay);
  }

  private audit(
    actor: string,
    action: string,
    target: string,
    result: string,
    errorCode?: string,
  ): void {
    const event: AuditEvent = { at: this.now(), actor, action, target, result };
    if (errorCode) event.errorCode = errorCode;
    this.auditLog.push(event);
    this.onAudit?.(event);
  }

  private persist(plan: CarePlanRecord): void {
    this.chain = this.chain
      .then(() => this.backend.put(plan))
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.onPersistError?.(wrapped);
      });
  }
}
