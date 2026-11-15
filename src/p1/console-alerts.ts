/**
 * #39 告警中心：把 C2 / 红线的 alert.created 事件落成可处理的告警。
 *
 * 状态机 open → acknowledged → resolved；resolved 不可重开。
 * 释放队列与恢复顾问通过 AlertOpsPort 调到 zhiban-wecom；未安装时返回 502。
 * 日志、审计、事件都不带消息正文（事件本身也不带）。
 */
import { ConsoleError } from './console-error.ts';
import type { ConsoleStore } from './console-store.ts';
import {
  alertMeta,
  C2_ALERT_KIND,
  type AlertKind,
  type AlertRecord,
  type AlertSeverity,
  type AlertStatus,
  type Page,
  paginate,
} from './console-types.ts';

export interface AlertActor {
  id: string;
  name: string;
  role: string;
}

export interface AlertOpsPort {
  releaseQueue(advisorId: string): Promise<{ releasedDraftId: string; nextDraftId: string | null }>;
  restoreAdvisor(
    advisorId: string,
  ): Promise<{ id: string; name: string; status: 'active'; consecutiveMisroutes: number }>;
}

export interface AlertServiceOptions {
  tenantId: string;
  store: ConsoleStore;
  now?: () => number;
  emit?: (type: string, data: unknown) => void;
  ops?: () => AlertOpsPort | undefined;
}

export interface AlertQuery {
  kind?: string;
  status?: string;
  advisorId?: string;
  patientId?: string;
  draftId?: string;
  /** 告警来源：staff（员工群发言）/ draft（AI 草稿） */
  source?: string;
  from?: number;
  to?: number;
  sandbox?: boolean;
  page?: number;
  pageSize?: number;
}

/** 只接受已知来源，避免拼错参数时静默返回空列表却看不出原因 */
export function parseAlertSource(raw: unknown): 'staff' | 'draft' | undefined {
  return raw === 'staff' || raw === 'draft' ? raw : undefined;
}

const ALERT_KINDS = new Set<AlertKind>([
  'misroute',
  'unverified',
  'remind',
  'escalate',
  'dead_letter',
  'advisor_paused',
  'redline',
  'push_failed',
  'no_chat_id',
  'patrol_silent',
  'patrol_complaint',
]);
const SEVERITIES = new Set<AlertSeverity>(['info', 'warning', 'critical']);
const STATUSES = new Set<AlertStatus>(['open', 'acknowledged', 'resolved']);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class AlertService {
  private readonly tenantId: string;
  private readonly store: ConsoleStore;
  private readonly now: () => number;
  private readonly emit: (type: string, data: unknown) => void;
  private readonly ops?: () => AlertOpsPort | undefined;

  constructor(options: AlertServiceOptions) {
    this.tenantId = options.tenantId;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.emit = options.emit ?? (() => undefined);
    this.ops = options.ops;
  }

  /**
   * 接收 `alert.created` 的平台事件。兼容：
   * - C2 Alert：{ kind: 'MISROUTE', message, at, advisorId, draftId }
   * - P1 / guard 告警实体：{ id, kind: 'redline', severity, status, ... }
   * 未知类型直接忽略，不让一个插件的事件打断控制台。
   */
  ingest(raw: unknown): AlertRecord | undefined {
    if (raw === null || typeof raw !== 'object') return undefined;
    const event = raw as Record<string, unknown>;
    const sourceKind = asString(event.kind);
    if (!sourceKind) return undefined;
    const kind = (ALERT_KINDS.has(sourceKind as AlertKind)
      ? sourceKind
      : C2_ALERT_KIND[sourceKind]) as AlertKind | undefined;
    if (!kind) return undefined;
    if (event.sandbox === true) return undefined;

    const sourceId = asString(event.id);
    if (sourceId && this.store.getAlert(sourceId)) return this.store.getAlert(sourceId);

    const meta = alertMeta(kind);
    const severityRaw = asString(event.severity);
    const severity =
      severityRaw && SEVERITIES.has(severityRaw as AlertSeverity)
        ? (severityRaw as AlertSeverity)
        : meta.severity;
    const statusRaw = asString(event.status);
    const status =
      statusRaw && STATUSES.has(statusRaw as AlertStatus) ? (statusRaw as AlertStatus) : 'open';
    const at = asNumber(event.createdAt) ?? asNumber(event.at) ?? this.now();
    const message = asString(event.message) ?? '';
    const sourceRaw = asString(event.source);
    const source = sourceRaw === 'staff' || sourceRaw === 'draft' ? sourceRaw : undefined;
    // 员工发言告警的详情包含发言人、群名、命中规则与原文摘录，放宽到 500 字；
    // 调用方负责截断，日志与事件仍不带正文。
    const record: AlertRecord = {
      id: sourceId && sourceId.startsWith('alt_') ? sourceId : this.store.newId('alt'),
      tenantId: this.tenantId,
      kind,
      severity,
      status,
      title: asString(event.title) ?? meta.title,
      message: message.slice(0, 500),
      draftId: asString(event.draftId) ?? null,
      patientId: asString(event.patientId) ?? null,
      advisorId: asString(event.advisorId) ?? null,
      groupId: asString(event.groupId) ?? null,
      ...(source ? { source } : {}),
      note: asString(event.note) ?? null,
      resolvedBy: asString(event.resolvedBy) ?? null,
      resolvedAt: asNumber(event.resolvedAt) ?? null,
      escalatedTo: asString(event.escalatedTo) ?? null,
      createdAt: at,
      updatedAt: asNumber(event.updatedAt) ?? at,
      sandbox: false,
    };
    this.store.saveAlert(record);
    this.emit('alert.created', record);
    return record;
  }

  /**
   * 接收 `alert.updated`。目前 guard 用它补发草稿关联（draftId）：告警先于草稿
   * 落库产生，创建事件里没有 draftId，回填后必须同步到控制台，否则服务流抽屉
   * 按 draftId 查不到这条告警，告警就成了谁也看不到的孤儿。
   *
   * 只补空着的关联字段，不覆盖控制台已经处理过的状态；本地还没有这条告警
   * （控制台重启、漏掉创建事件）时按创建处理，尽量把告警找回来。
   */
  applyUpdate(raw: unknown): AlertRecord | undefined {
    if (raw === null || typeof raw !== 'object') return undefined;
    const event = raw as Record<string, unknown>;
    const id = asString(event.id);
    if (!id) return undefined;
    const existing = this.store.getAlert(id);
    if (!existing) return this.ingest(raw);
    if (existing.tenantId !== this.tenantId) return undefined;

    const updated: AlertRecord = { ...existing };
    let changed = false;
    const draftId = asString(event.draftId);
    if (draftId && !updated.draftId) {
      updated.draftId = draftId;
      changed = true;
    }
    const patientId = asString(event.patientId);
    if (patientId && !updated.patientId) {
      updated.patientId = patientId;
      changed = true;
    }
    const advisorId = asString(event.advisorId);
    if (advisorId && !updated.advisorId) {
      updated.advisorId = advisorId;
      changed = true;
    }
    const groupId = asString(event.groupId);
    if (groupId && !updated.groupId) {
      updated.groupId = groupId;
      changed = true;
    }
    const sourceRaw = asString(event.source);
    if (!updated.source && (sourceRaw === 'staff' || sourceRaw === 'draft')) {
      updated.source = sourceRaw;
      changed = true;
    }
    if (!changed) return existing;
    updated.updatedAt = asNumber(event.updatedAt) ?? this.now();
    this.store.saveAlert(updated);
    this.emit('alert.updated', updated);
    return updated;
  }

  list(query: AlertQuery = {}): Page<AlertRecord> {
    const from = query.from;
    const to = query.to;
    const items = this.store
      .listAlerts()
      .filter((alert) => alert.tenantId === this.tenantId)
      .filter((alert) => alert.sandbox === (query.sandbox === true))
      .filter((alert) => (query.kind ? alert.kind === query.kind : true))
      .filter((alert) => (query.status ? alert.status === query.status : true))
      .filter((alert) => (query.advisorId ? alert.advisorId === query.advisorId : true))
      .filter((alert) => (query.patientId ? alert.patientId === query.patientId : true))
      .filter((alert) => (query.draftId ? alert.draftId === query.draftId : true))
      .filter((alert) => (query.source ? alert.source === query.source : true))
      .filter((alert) => (from === undefined ? true : alert.createdAt >= from))
      .filter((alert) => (to === undefined ? true : alert.createdAt < to))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return paginate(items, query.page, query.pageSize);
  }

  /**
   * 未解决告警计数。传 `source` 时只算该来源——控制台菜单角标只关心
   * 员工群发言红线，避免超时、推送失败等运维告警把数字冲高。
   */
  unresolvedCount(source?: 'staff' | 'draft'): { open: number; acknowledged: number; total: number } {
    const items = this.store
      .listAlerts()
      .filter((alert) => alert.tenantId === this.tenantId && !alert.sandbox)
      .filter((alert) => (source ? alert.source === source : true));
    const open = items.filter((alert) => alert.status === 'open').length;
    const acknowledged = items.filter((alert) => alert.status === 'acknowledged').length;
    return { open, acknowledged, total: open + acknowledged };
  }

  get(id: string): AlertRecord {
    const alert = this.store.getAlert(id);
    if (!alert || alert.tenantId !== this.tenantId) {
      throw new ConsoleError('NOT_FOUND', `告警 ${id} 不存在`);
    }
    return alert;
  }

  resolve(id: string, note: unknown, actor: AlertActor): AlertRecord {
    const alert = this.get(id);
    const clean = this.validateNote(note, true)!;
    if (alert.status === 'resolved') {
      throw new ConsoleError('CONFLICT', '告警已解决，不能重复处理');
    }
    const now = this.now();
    const updated: AlertRecord = {
      ...alert,
      status: 'resolved',
      note: clean,
      resolvedBy: actor.id,
      resolvedAt: now,
      updatedAt: now,
    };
    this.store.saveAlert(updated);
    this.audit(actor, 'alert.resolve', 'alert', id, 'success', { noteLength: clean.length });
    this.emit('alert.resolved', updated);
    this.emit('alert.updated', updated);
    return updated;
  }

  /**
   * 实时服务流里人工核实一条「未核验」草稿：把挂在它上面的未核验告警一并关掉。
   *
   * UNVERIFIED 是草稿终态，草稿本身不改状态；要清掉的是它产生的待办告警。
   * 备注必填，审计记在草稿上；重复核实只会再记一条审计，不会报错。
   */
  resolveDraftUnverified(
    draftId: string,
    note: unknown,
    actor: AlertActor,
  ): { resolved: number; alertIds: string[] } {
    const clean = this.validateNote(note, true)!;
    const pending = this.store
      .listAlerts()
      .filter(
        (alert) =>
          alert.tenantId === this.tenantId &&
          !alert.sandbox &&
          alert.draftId === draftId &&
          alert.kind === 'unverified' &&
          alert.status !== 'resolved',
      );
    const now = this.now();
    for (const alert of pending) {
      const updated: AlertRecord = {
        ...alert,
        status: 'resolved',
        note: clean,
        resolvedBy: actor.id,
        resolvedAt: now,
        updatedAt: now,
      };
      this.store.saveAlert(updated);
      this.emit('alert.resolved', updated);
      this.emit('alert.updated', updated);
    }
    this.audit(actor, 'draft.unverified.reviewed', 'draft', draftId, 'success', {
      noteLength: clean.length,
      alertIds: pending.map((alert) => alert.id),
    });
    return { resolved: pending.length, alertIds: pending.map((alert) => alert.id) };
  }

  async releaseQueue(
    id: string,
    actor: AlertActor,
  ): Promise<{ alert: AlertRecord; releasedDraftId: string; nextDraftId: string | null }> {
    const alert = this.get(id);
    if (alert.status === 'resolved') {
      throw new ConsoleError('CONFLICT', '告警已解决，不能再次释放队列');
    }
    if (!alert.advisorId) {
      throw new ConsoleError('CONFLICT', '该告警没有关联顾问，无法释放队列');
    }
    const ops = this.requireOps();
    let result: { releasedDraftId: string; nextDraftId: string | null };
    try {
      result = await ops.releaseQueue(alert.advisorId);
    } catch (error) {
      throw this.mapOpsError(error);
    }
    const updated = this.acknowledge(alert, actor, `已释放队列：${result.releasedDraftId}`);
    this.audit(actor, 'advisor.queue.release', 'advisor', alert.advisorId, 'success', {
      alertId: id,
      releasedDraftId: result.releasedDraftId,
      nextDraftId: result.nextDraftId,
    });
    return { alert: updated, ...result };
  }

  async restoreAdvisor(
    id: string,
    actor: AlertActor,
  ): Promise<{
    alert: AlertRecord;
    advisor: { id: string; name: string; status: 'active'; consecutiveMisroutes: number };
  }> {
    const alert = this.get(id);
    if (alert.status === 'resolved') {
      throw new ConsoleError('CONFLICT', '告警已解决，不能再次恢复顾问');
    }
    if (!alert.advisorId) {
      throw new ConsoleError('CONFLICT', '该告警没有关联顾问，无法恢复');
    }
    const ops = this.requireOps();
    let advisor: { id: string; name: string; status: 'active'; consecutiveMisroutes: number };
    try {
      advisor = await ops.restoreAdvisor(alert.advisorId);
    } catch (error) {
      throw this.mapOpsError(error);
    }
    const updated = this.acknowledge(alert, actor, `已恢复顾问：${advisor.name}`);
    this.audit(actor, 'advisor.resume', 'advisor', alert.advisorId, 'success', { alertId: id });
    this.emit('advisor.updated', {
      id: advisor.id,
      name: advisor.name,
      status: advisor.status,
      consecutiveMisroutes: advisor.consecutiveMisroutes,
    });
    return { alert: updated, advisor };
  }

  private acknowledge(alert: AlertRecord, _actor: AlertActor, note: string): AlertRecord {
    const now = this.now();
    const updated: AlertRecord = {
      ...alert,
      status: alert.status === 'open' ? 'acknowledged' : alert.status,
      note,
      updatedAt: now,
    };
    this.store.saveAlert(updated);
    this.emit('alert.updated', updated);
    return updated;
  }

  private validateNote(note: unknown, required: boolean): string | null {
    if (note === undefined || note === null) {
      if (required) throw new ConsoleError('VALIDATION_FAILED', '处理备注不能为空');
      return null;
    }
    if (typeof note !== 'string') {
      throw new ConsoleError('VALIDATION_FAILED', '处理备注必须是字符串');
    }
    const clean = note.trim();
    if (required && clean === '') {
      throw new ConsoleError('VALIDATION_FAILED', '处理备注不能为空');
    }
    if (clean.length > 200) {
      throw new ConsoleError('VALIDATION_FAILED', '处理备注不能超过 200 字', [
        { field: 'note', issue: 'max 200 chars' },
      ]);
    }
    return clean === '' ? null : clean;
  }

  private requireOps(): AlertOpsPort {
    const ops = this.ops?.();
    if (!ops) {
      throw new ConsoleError('UPSTREAM_UNAVAILABLE', '企微通道插件未安装或尚未就绪');
    }
    return ops;
  }

  private mapOpsError(error: unknown): ConsoleError {
    if (error instanceof ConsoleError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DRAFT_NOT_FOUND') || message.includes('ADVISOR_NOT_FOUND')) {
      return new ConsoleError('NOT_FOUND', message);
    }
    if (message.includes('NO_ACTIVE_DRAFT')) {
      return new ConsoleError('CONFLICT', '没有可释放的阻塞草稿');
    }
    return new ConsoleError('UPSTREAM_UNAVAILABLE', `企微通道操作失败：${message}`);
  }

  private audit(
    actor: AlertActor,
    action: string,
    targetType: string,
    targetId: string,
    result: 'success' | 'failure',
    detail?: Record<string, unknown>,
  ): void {
    this.store.appendAudit({
      tenantId: this.tenantId,
      actorType: actor.role === 'platform' ? 'platform' : 'account',
      actorId: actor.id,
      actorName: actor.name,
      action,
      targetType,
      targetId,
      result,
      detail,
      sandbox: false,
    });
  }
}
