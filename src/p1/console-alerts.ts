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
  from?: number;
  to?: number;
  sandbox?: boolean;
  page?: number;
  pageSize?: number;
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
      .filter((alert) => (from === undefined ? true : alert.createdAt >= from))
      .filter((alert) => (to === undefined ? true : alert.createdAt < to))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return paginate(items, query.page, query.pageSize);
  }

  unresolvedCount(): { open: number; acknowledged: number; total: number } {
    const items = this.store
      .listAlerts()
      .filter((alert) => alert.tenantId === this.tenantId && !alert.sandbox);
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
