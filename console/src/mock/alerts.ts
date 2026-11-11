/**
 * 质检与告警 mock。按 docs/P1-api.md §9：
 * - 列表默认排除沙盒
 * - 标记已处理必须填写备注（≤200 字），已解决再次处理返回 409
 * - 释放队列 / 恢复顾问返回关联对象
 */
import advisorsFixture from './fixtures/advisors.json';
import alertsFixture from './fixtures/alerts.json';
import draftsFixture from './fixtures/drafts.json';
import patientsFixture from './fixtures/patients.json';
import { resumeAdvisor } from './advisors.ts';
import { API_BASE, ApiError, isMockMode } from './http.ts';

export type AlertKind =
  | 'misroute'
  | 'unverified'
  | 'timeout_remind'
  | 'timeout_escalate'
  | 'dead_letter'
  | 'advisor_paused'
  | 'redline'
  | 'escalate';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface Alert {
  id: string;
  tenantId: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string;
  draftId: string | null;
  patientId: string | null;
  advisorId: string | null;
  groupId: string | null;
  /** 告警来源：员工群发言 / AI 草稿；历史告警可能没有该字段 */
  source?: 'draft' | 'staff' | null;
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  escalatedTo: string | null;
  createdAt: number;
  updatedAt: number;
  sandbox: boolean;
}

export interface AlertList {
  items: Alert[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AlertDetail {
  alert: Alert;
  draft: { id: string; summary: string; status: string; riskLevel: string } | null;
  patient: { id: string; displayName: string } | null;
  advisor: { id: string; name: string } | null;
}

export interface AlertCount {
  open: number;
  acknowledged: number;
  total: number;
}

export interface AlertQuery {
  kind?: AlertKind | string;
  status?: AlertStatus | string;
  advisorId?: string;
  patientId?: string;
  from?: number;
  to?: number;
  page?: number;
  pageSize?: number;
}

const STORAGE_KEY = 'zhiban.console.j.alerts';

interface DraftRaw {
  id: string;
  patientId: string;
  advisorId: string;
  inboundSummary: string;
  status: string;
  riskLevel: string;
}

const seed = alertsFixture as unknown as Alert[];
const drafts = draftsFixture as unknown as DraftRaw[];
const patients = patientsFixture as unknown as { id: string; displayName: string }[];
const advisors = advisorsFixture as unknown as { id: string; name: string }[];

const patientMap = new Map(patients.map((item) => [item.id, item]));
const advisorMap = new Map(advisors.map((item) => [item.id, item]));

const listeners = new Set<() => void>();
let realSource: EventSource | null = null;

function readState(): Alert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Alert[]) : seed.map((item) => ({ ...item }));
  } catch {
    return seed.map((item) => ({ ...item }));
  }
}

function writeState(items: Alert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // 隐私模式下仅当前会话生效
  }
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 仅供测试 / 演示重置：恢复 fixture 并通知菜单角标 */
export function resetAlertsMock(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  notify();
}

/**
 * 服务端 SSE 每帧带 `event: <type>` 名，命名事件不会触发 EventSource.onmessage。
 * 订阅时按已知类型逐个 addEventListener，并保留 onmessage 兜底。
 */
const ALERT_EVENT_TYPES = ['alert.created', 'alert.updated', 'alert.resolved'] as const;

/** 订阅告警变化；真实模式走 SSE alert.*，mock 模式走本地事件总线 */
export function subscribeAlerts(listener: () => void): () => void {
  if (!isMockMode) {
    listeners.add(listener);
    if (!realSource) {
      realSource = new EventSource(`${API_BASE}/stream?types=alert.*`, {
        withCredentials: true,
      });
      const refresh = () => notify();
      for (const type of ALERT_EVENT_TYPES) realSource.addEventListener(type, refresh);
      realSource.onmessage = refresh;
      // 断线重连后补一次 REST 校准，避免漏掉断线期间的事件
      realSource.onopen = refresh;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && realSource) {
        realSource.close();
        realSource = null;
      }
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function listAlerts(query: AlertQuery = {}): Promise<AlertList> {
  if (!isMockMode) {
    return apiRequest<AlertList>(
      `/alerts${queryString({
        kind: query.kind,
        status: query.status,
        advisorId: query.advisorId,
        patientId: query.patientId,
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  }

  const filtered = readState()
    .filter((item) => !item.sandbox)
    .filter((item) => (query.kind ? item.kind === query.kind : true))
    .filter((item) => (query.status ? item.status === query.status : true))
    .filter((item) => (query.advisorId ? item.advisorId === query.advisorId : true))
    .filter((item) => (query.patientId ? item.patientId === query.patientId : true))
    .filter((item) => (query.from ? item.createdAt >= query.from : true))
    .filter((item) => (query.to ? item.createdAt <= query.to : true))
    .sort((a, b) => b.createdAt - a.createdAt);

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: filtered.length,
  };
}

export async function unresolvedCount(): Promise<AlertCount> {
  if (!isMockMode) return apiRequest<AlertCount>('/alerts/unresolved-count');
  const items = readState().filter((item) => !item.sandbox);
  const open = items.filter((item) => item.status === 'open').length;
  const acknowledged = items.filter((item) => item.status === 'acknowledged').length;
  return { open, acknowledged, total: open + acknowledged };
}

export async function getAlertDetail(id: string): Promise<AlertDetail> {
  if (!isMockMode) return apiRequest<AlertDetail>(`/alerts/${id}`);
  const alert = readState().find((item) => item.id === id);
  if (!alert) throw new ApiError('NOT_FOUND', '告警不存在', 404);
  const draft = alert.draftId ? (drafts.find((item) => item.id === alert.draftId) ?? null) : null;
  return {
    alert,
    draft: draft
      ? {
          id: draft.id,
          summary: draft.inboundSummary,
          status: draft.status,
          riskLevel: draft.riskLevel,
        }
      : null,
    patient: alert.patientId ? (patientMap.get(alert.patientId) ?? null) : null,
    advisor: alert.advisorId ? (advisorMap.get(alert.advisorId) ?? null) : null,
  };
}

export async function resolveAlert(id: string, note: string): Promise<Alert> {
  const trimmed = note.trim();
  if (!trimmed) throw new ApiError('VALIDATION_FAILED', '处理备注不能为空', 422);
  if (trimmed.length > 200) {
    throw new ApiError('VALIDATION_FAILED', '处理备注不能超过 200 字', 422);
  }

  if (!isMockMode) {
    const alert = await apiRequest<Alert>(`/alerts/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note: trimmed }),
    });
    // 本地先刷新一次，SSE 慢或断线时菜单角标也不会停在旧值
    notify();
    return alert;
  }

  const items = readState();
  const target = items.find((item) => item.id === id);
  if (!target) throw new ApiError('NOT_FOUND', '告警不存在', 404);
  if (target.status === 'resolved') {
    throw new ApiError('CONFLICT', '该告警已处理', 409);
  }
  const now = Date.now();
  target.status = 'resolved';
  target.note = trimmed;
  target.resolvedBy = 'acc_01';
  target.resolvedAt = now;
  target.updatedAt = now;
  writeState(items);
  return { ...target };
}

export async function releaseQueue(id: string): Promise<{
  alert: Alert;
  releasedDraftId: string;
  nextDraftId: string | null;
}> {
  if (!isMockMode) {
    const result = await apiRequest<{
      alert: Alert;
      releasedDraftId: string;
      nextDraftId: string | null;
    }>(`/alerts/${id}/release-queue`, { method: 'POST' });
    notify();
    return result;
  }

  const items = readState();
  const target = items.find((item) => item.id === id);
  if (!target) throw new ApiError('NOT_FOUND', '告警不存在', 404);
  if (!target.draftId) throw new ApiError('CONFLICT', '该告警没有关联草稿', 409);

  const released = drafts.find((item) => item.id === target.draftId);
  if (!released) throw new ApiError('NOT_FOUND', '关联草稿不存在', 404);

  const next = drafts
    .filter(
      (item) =>
        item.advisorId === released.advisorId &&
        item.id !== released.id &&
        ['QUEUED', 'PUSHED'].includes(item.status),
    )
    .find(() => true);

  target.status = 'acknowledged';
  target.note = `已释放阻塞队列：${released.id}`;
  target.updatedAt = Date.now();
  writeState(items);
  return {
    alert: { ...target },
    releasedDraftId: released.id,
    nextDraftId: next?.id ?? null,
  };
}

export async function restoreAdvisor(id: string): Promise<{ alert: Alert; advisorId: string }> {
  if (!isMockMode) {
    const result = await apiRequest<{ alert: Alert; advisorId: string }>(
      `/alerts/${id}/restore-advisor`,
      { method: 'POST' },
    );
    notify();
    return result;
  }

  const items = readState();
  const target = items.find((item) => item.id === id);
  if (!target) throw new ApiError('NOT_FOUND', '告警不存在', 404);
  if (!target.advisorId) throw new ApiError('CONFLICT', '该告警没有关联顾问', 409);

  await resumeAdvisor(target.advisorId);
  const now = Date.now();
  target.status = 'resolved';
  target.note = '已恢复顾问接单';
  target.resolvedBy = 'acc_01';
  target.resolvedAt = now;
  target.updatedAt = now;
  writeState(items);
  return { alert: { ...target }, advisorId: target.advisorId };
}

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  misroute: '发错群',
  unverified: '未核验',
  timeout_remind: '超时提醒',
  timeout_escalate: '超时升级',
  dead_letter: '推送死信',
  advisor_paused: '顾问被暂停',
  redline: '健康红线',
  escalate: '升级主管',
};

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  open: '待处理',
  acknowledged: '处理中',
  resolved: '已处理',
};

export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, { label: string; color: string }> = {
  critical: { label: '严重', color: 'red' },
  warning: { label: '警告', color: 'gold' },
  info: { label: '提示', color: 'blue' },
};

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new ApiError(
      error?.code || 'INTERNAL',
      error?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return payload as T;
}
