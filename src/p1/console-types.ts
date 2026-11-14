/**
 * #41 控制台后端的共享类型：租户、账号、会话、审计、告警、沙盒。
 *
 * 字段以 docs/P1-data-model.md 为准；接口以 docs/P1-api.md 为准。
 * 本文件只放类型与纯函数，HTTP / 存储 / 插件装配在 plugins/zhiban-console/。
 */
import type { AuditEvent as C2AuditEvent } from '../c2/types.ts';

// ---------- 角色与权限 ----------

export type Role = 'admin' | 'supervisor' | 'viewer' | 'platform';

export const ROLES: readonly Role[] = ['admin', 'supervisor', 'viewer', 'platform'];

export type Permission =
  | 'tenant.read'
  | 'tenant.write'
  | 'patient.read'
  | 'patient.write'
  | 'draft.read'
  | 'alert.read'
  | 'alert.write'
  | 'advisor.operate'
  | 'audit.read'
  | 'export'
  | 'account.write'
  | 'onboarding.submit'
  | 'onboarding.list'
  | 'sandbox.use';

export const ALL_PERMISSIONS: readonly Permission[] = [
  'tenant.read',
  'tenant.write',
  'patient.read',
  'patient.write',
  'draft.read',
  'alert.read',
  'alert.write',
  'advisor.operate',
  'audit.read',
  'export',
  'account.write',
  'onboarding.submit',
  'onboarding.list',
  'sandbox.use',
];

/** 与 P1-api.md §1.6 / §14 权限矩阵一致；admin 通配 */
const ROLE_PERMISSIONS: Record<Exclude<Role, 'admin'>, readonly Permission[]> = {
  supervisor: [
    'tenant.read',
    'patient.read',
    'patient.write',
    'draft.read',
    'alert.read',
    'alert.write',
    'advisor.operate',
    'audit.read',
    'export',
    'onboarding.submit',
    'sandbox.use',
  ],
  viewer: ['tenant.read', 'patient.read', 'draft.read', 'alert.read', 'audit.read', 'sandbox.use'],
  platform: ['onboarding.list'],
};

export function permissionsFor(role: Role): Permission[] {
  if (role === 'admin') return [...ALL_PERMISSIONS];
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return role === 'admin' || permissionsFor(role).includes(permission);
}

export function isTenantRole(role: Role): boolean {
  return role !== 'platform';
}

// ---------- 租户 ----------

/**
 * 服务对象称谓：保留常用预设，也允许机构自定义（如「亲人」「家人」「长者」）。
 * 只约束长度与字符，不再限定枚举，保证不同机构各用各的叫法。
 */
export type PatientTerm = string;

/** 自定义称谓的最大长度（按字符计） */
export const PATIENT_TERM_MAX_LENGTH = 8;

/** 控制台下拉里给出的预设；不是白名单 */
export const PATIENT_TERMS: readonly PatientTerm[] = ['患者', '客户', '会员', '亲人', '家人'];

/** 去空白后 1–8 个字符，且不含控制字符 */
export function isValidPatientTerm(value: string): boolean {
  const term = value.trim();
  return (
    term.length >= 1 &&
    term.length <= PATIENT_TERM_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(term)
  );
}

export interface TenantSettings {
  archiveSeatPriceYuan: number;
  writeMinutesPerDraft: number;
  mergeWindowSeconds: number;
  quietHours: { start: string; end: string };
  proactivePerHour: number;
  modelName: string;
  retentionNotice: string;
  memoryInjectLimit: number;
}

export interface TenantRecord {
  id: string;
  name: string;
  agentName: string;
  agentAvatar: string | null;
  patientTerm: PatientTerm;
  tone: string;
  timezone: string;
  settings: TenantSettings;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  archiveSeatPriceYuan: 900,
  writeMinutesPerDraft: 3,
  mergeWindowSeconds: 30,
  quietHours: { start: '21:00', end: '08:00' },
  proactivePerHour: 6,
  modelName: 'deepseek-v4.1-flash',
  retentionNotice: '按合同约定；当前演示环境不自动删除',
  memoryInjectLimit: 30,
};

// ---------- 账号与会话 ----------

export type AccountStatus = 'active' | 'disabled';

export interface AccountRecord {
  id: string;
  /** platform 账号不属于任何租户 */
  tenantId: string | null;
  username: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
  /** scrypt 强哈希，任何响应都不返回 */
  passwordHash: string;
  lastLoginAt?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** 对外账号视图：永远不含密码哈希 */
export type PublicAccount = Omit<AccountRecord, 'passwordHash'>;

export interface SessionRecord {
  /** 只存 token 的 SHA-256，不存明文 */
  tokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

// ---------- 审计 ----------

export type ActorType = 'account' | 'system' | 'agent' | 'platform';

export interface ConsoleAuditEvent {
  id: string;
  tenantId: string | null;
  actorType: ActorType;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: 'success' | 'failure';
  detail?: Record<string, unknown>;
  errorCode?: string;
  ip?: string;
  at: number;
  sandbox: boolean;
}

/** C2 / 其它插件的审计事件 → 控制台审计实体 */
export function mapC2Audit(
  event: C2AuditEvent,
  context: { tenantId: string; targetType?: string; ip?: string },
  makeId: () => string,
): ConsoleAuditEvent {
  const ok = event.result === 'ok' || event.result === 'success';
  return {
    id: makeId(),
    tenantId: context.tenantId,
    actorType: event.actor === 'system' || event.actor === 'pipeline' ? 'system' : 'account',
    actorId: event.actor === 'system' || event.actor === 'pipeline' ? null : event.actor,
    actorName: event.actor,
    action: event.action,
    targetType: context.targetType ?? 'unknown',
    targetId: event.target || null,
    result: ok ? 'success' : 'failure',
    detail: event.errorCode ? { errorCode: event.errorCode.slice(0, 120) } : undefined,
    errorCode: event.errorCode?.slice(0, 120),
    ip: context.ip,
    at: event.at,
    sandbox: false,
  };
}

// ---------- 告警 ----------

export type AlertKind =
  | 'misroute'
  | 'unverified'
  | 'remind'
  | 'escalate'
  | 'dead_letter'
  | 'advisor_paused'
  | 'redline'
  | 'push_failed'
  | 'no_chat_id'
  | 'patrol_silent'
  | 'patrol_complaint';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface AlertRecord {
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
  /** 告警来源：员工群发言 / AI 草稿；历史记录可能为空 */
  source?: 'draft' | 'staff';
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  escalatedTo: string | null;
  createdAt: number;
  updatedAt: number;
  sandbox: boolean;
}

/** C2 AlertKind → P1 alert.kind（数据模型 §3.16） */
export const C2_ALERT_KIND: Record<string, AlertKind> = {
  MISROUTE: 'misroute',
  UNVERIFIED: 'unverified',
  DEAD_LETTER: 'dead_letter',
  ADVISOR_PAUSED: 'advisor_paused',
  ESCALATED: 'escalate',
  PUSH_FAILED: 'push_failed',
  NO_CHATID: 'no_chat_id',
  DOWNTIME: 'push_failed',
  BOT_DISCONNECTED: 'push_failed',
  PERSIST_FAILED: 'push_failed',
  PATROL_SILENT: 'patrol_silent',
  PATROL_COMPLAINT: 'patrol_complaint',
};

const ALERT_META: Record<AlertKind, { title: string; severity: AlertSeverity }> = {
  misroute: { title: '发错群', severity: 'critical' },
  unverified: { title: '未核验', severity: 'warning' },
  remind: { title: '草稿待处理提醒', severity: 'info' },
  escalate: { title: '草稿超时升级', severity: 'critical' },
  dead_letter: { title: '推送失败进入死信', severity: 'critical' },
  advisor_paused: { title: '顾问已暂停', severity: 'critical' },
  redline: { title: '健康红线命中', severity: 'warning' },
  push_failed: { title: '推送失败', severity: 'warning' },
  no_chat_id: { title: '顾问尚未开通机器人会话', severity: 'warning' },
  patrol_silent: { title: '巡检：客户长期沉默', severity: 'warning' },
  patrol_complaint: { title: '巡检：投诉/风险信号', severity: 'critical' },
};

export function alertMeta(kind: AlertKind): { title: string; severity: AlertSeverity } {
  return ALERT_META[kind];
}

// ---------- 沙盒 ----------

export type SandboxDraftStatus =
  | 'PUSHED'
  | 'VERIFIED'
  | 'EDIT_SENT'
  | 'MISROUTE_ALERT'
  | 'UNVERIFIED';

export type SandboxOutcome = 'verified' | 'edit_sent' | 'misroute' | 'unverified';

export interface SandboxSessionRecord {
  id: string;
  tenantId: string;
  accountId: string;
  patientId: string;
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface SandboxPatientView {
  id: string;
  displayName: string;
  demo: boolean;
}

export interface SandboxMessage {
  id: string;
  tenantId: string;
  accountId: string;
  at: number;
  sender: 'customer' | 'agent' | 'advisor';
  kind: 'text' | 'image';
  text?: string;
  mediaId?: string;
}

export interface SandboxDraft {
  id: string;
  tenantId: string;
  accountId: string;
  version: number;
  body: string;
  status: SandboxDraftStatus;
  riskLevel: 'low' | 'medium' | 'high';
  inboundSummary: string;
  /** #64：模板降级，评测报告据此判定回合失败 */
  fallback?: boolean;
  /** #55：本轮图片类型 */
  mediaKinds?: string[];
  createdAt: number;
  updatedAt: number;
  sandbox: true;
}

export interface SandboxVerification {
  id: string;
  tenantId: string;
  accountId: string;
  draftId: string;
  outcome: SandboxOutcome;
  matchedMsgId: string | null;
  matchedRoomId: string | null;
  matchedGroupName: string | null;
  similarity: number | null;
  attempts: number;
  checkedAt: number;
  sandbox: true;
}

export interface SandboxEvent {
  id: string;
  tenantId: string;
  accountId: string;
  type: string;
  at: number;
  data: Record<string, unknown>;
}

export interface SandboxMemory {
  id: string;
  tenantId: string;
  accountId: string;
  category: string;
  content: string;
  createdAt: number;
}

export interface SandboxQuota {
  accountId: string;
  /** 租户时区内的日期 YYYY-MM-DD */
  day: string;
  used: number;
}

export const SANDBOX_DAILY_LIMIT = 100;

export interface SandboxPreset {
  id: string;
  label: string;
  kind: 'text' | 'image';
  /** 文本预置要发给 Agent 的原话；图片预置不需要 */
  text?: string;
  mediaId?: string;
}

export const SANDBOX_PRESETS: readonly SandboxPreset[] = [
  { id: 'preset_allergy', label: '我对海鲜过敏', kind: 'text', text: '我对海鲜过敏' },
  { id: 'preset_dinner', label: '晚上吃什么好', kind: 'text', text: '晚上吃什么好' },
  { id: 'preset_meal_photo', label: '发一张餐食照片', kind: 'image', mediaId: 'med_sample_meal_01' },
];

export const SANDBOX_GUIDE_STEPS = [
  { step: 1, title: '告诉 Agent 一件重要的事', hint: '点击「我对海鲜过敏」' },
  { step: 2, title: '看记忆面板', hint: '右侧出现一条饮食禁忌记忆' },
  { step: 3, title: '问一个相关问题', hint: '点击「晚上吃什么好」，草稿会避开海鲜' },
  { step: 4, title: '试试四种发送方式', hint: '照发 / 改写后发 / 发到别的群 / 只点已发送' },
] as const;

// ---------- 话术库（#120） ----------

/** 顾问可查询、复制到企微的机构内容；不参与 Agent 草稿生成。 */
export interface ScriptRecord {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export const SCRIPT_TITLE_MAX = 60;
export const SCRIPT_CONTENT_MAX = 2000;
export const SCRIPT_CATEGORY_MAX = 30;
export const SCRIPT_TAGS_MAX = 5;
export const SCRIPT_TAG_MAX = 10;

// ---------- 通用 ----------

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function paginate<T>(items: T[], page = 1, pageSize = 20): Page<T> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(100, Math.floor(pageSize)) : 20;
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total: items.length,
  };
}

/** 租户时区内的日期（en-CA 输出 YYYY-MM-DD） */
export function dayKey(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}
