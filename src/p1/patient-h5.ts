/**
 * PH5-02（#231）患者端 H5：身份、邀请、会话、分项授权与隐私申请。
 *
 * 领域逻辑与 HTTP / 存储分离：本文件不依赖 node:http，可独立测试。
 * 契约：docs/PATIENT-H5-data-model.md §3.1–§3.4、§3.13、§4、§5；docs/PATIENT-H5-api.md §2–§3。
 *
 * 隐私红线（契约 §1.5）：手机号与验证码不进审计 detail、不进埋点；
 * 日志由调用方保证不含手机号、令牌、健康正文。
 */
import { hashToken, newSessionToken } from './console-auth.ts';
import type { IdFactory } from './ids.ts';

// ---------- 错误 ----------

export type H5ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_EXPIRED'
  | 'PHONE_MISMATCH'
  | 'VERIFY_CODE_INVALID'
  | 'SMS_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'SERVICE_PAUSED'
  | 'CONSENT_REQUIRED'
  | 'INTERNAL';

const ERROR_STATUS: Record<H5ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  INVITATION_NOT_FOUND: 404,
  INVITATION_EXPIRED: 410,
  PHONE_MISMATCH: 422,
  VERIFY_CODE_INVALID: 422,
  SMS_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  SERVICE_PAUSED: 403,
  CONSENT_REQUIRED: 403,
  INTERNAL: 500,
};

export class H5Error extends Error {
  readonly code: H5ErrorCode;
  readonly status: number;
  readonly details?: Array<Record<string, unknown>>;

  constructor(code: H5ErrorCode, message: string, details?: Array<Record<string, unknown>>) {
    super(message);
    this.name = 'H5Error';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    this.details = details;
  }
}

// ---------- 实体 ----------

export type InvitationStatus = 'pending' | 'used' | 'expired' | 'revoked';

export interface InvitationRecord {
  id: string;
  tenantId: string;
  patientId: string;
  advisorId: string;
  /** 预绑定手机号；只在创建与核验时使用，不进任何响应/审计 */
  phone: string;
  phoneTail: string;
  code: string;
  status: InvitationStatus;
  expiresAt: number;
  usedAt?: number;
  usedSessionId?: string;
  revokedAt?: number;
  revokedBy?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = 'active' | 'revoked' | 'expired';
export type SessionAuthMethod = 'invite_sms' | 'phone_sms';

export interface H5SessionRecord {
  id: string;
  tenantId: string;
  patientId: string;
  /** Cookie 令牌的 SHA-256；令牌本体不落库 */
  tokenHash: string;
  authMethod: SessionAuthMethod;
  status: SessionStatus;
  issuedAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt?: number;
  revokedBy?: 'patient' | 'account' | 'system';
  revokedById?: string;
  userAgentSummary?: string;
}

export interface H5BindingRecord {
  id: string;
  tenantId: string;
  patientId: string;
  /** 只用于核验，不进响应与日志 */
  phone: string;
  phoneTail: string;
  status: 'bound' | 'unbound';
  boundAt: number;
  boundVia: string;
  unboundAt?: number;
  unboundBy?: string;
}

export type ConsentScope =
  | 'service_basic'
  | 'health_processing'
  | 'photo_analysis'
  | 'team_access'
  | 'reminder';

export type ConsentStatus = 'granted' | 'withdrawn' | 'never';

export interface ConsentRecord {
  id: string;
  tenantId: string;
  patientId: string;
  scope: ConsentScope;
  status: ConsentStatus;
  version: number;
  grantedAt?: number;
  withdrawnAt?: number;
  decidedVia?: string;
  history: Array<{ action: 'grant' | 'withdraw'; at: number; version: number; via?: string }>;
  updatedAt: number;
}

export type PrivacyRequestKind = 'export' | 'correction' | 'deletion';
export type PrivacyRequestStatus = 'submitted' | 'handled' | 'rejected';

export interface PrivacyRequestRecord {
  id: string;
  tenantId: string;
  patientId: string;
  kind: PrivacyRequestKind;
  targetType?: string;
  targetId?: string;
  detail: string;
  status: PrivacyRequestStatus;
  handledBy?: string;
  handledAt?: number;
  resultNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface H5AuditRecord {
  id: string;
  tenantId: string;
  actorType: 'patient' | 'account' | 'system';
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: 'success' | 'failure';
  /** 只含 id、枚举、版本；不含手机号、正文、令牌 */
  detail?: Record<string, unknown>;
  errorCode?: string;
  at: number;
}

export interface H5EventRecord {
  id: string;
  tenantId: string;
  patientId: string;
  event: string;
  itemId?: string;
  durationMs?: number;
  at: number;
}

export interface IdempotencyRecord {
  key: string;
  tenantId: string;
  patientId: string;
  endpoint: string;
  response?: unknown;
  at: number;
}

// ---------- 短信端口 ----------

export interface SmsPort {
  readonly mode: 'mock' | 'real' | 'unconfigured';
  sendCode(phone: string, code: string): Promise<void>;
}

/** 开发/测试：不发真实短信，验证码固定 000000（契约 api §15，生产禁用） */
export const MOCK_SMS: SmsPort = {
  mode: 'mock',
  async sendCode(): Promise<void> {
    /* mock：静默 */
  },
};

export const UNCONFIGURED_SMS: SmsPort = {
  mode: 'unconfigured',
  async sendCode(): Promise<void> {
    throw new H5Error('SMS_UNAVAILABLE', '短信通道未配置，真实登录暂不可用');
  },
};

export const MOCK_VERIFY_CODE = '000000';

// ---------- 授权文案 ----------

export interface ConsentScopeMeta {
  scope: ConsentScope;
  title: string;
  summary: string;
}

export const CONSENT_SCOPES: readonly ConsentScope[] = [
  'service_basic',
  'health_processing',
  'photo_analysis',
  'team_access',
  'reminder',
];

export const DEFAULT_CONSENT_TEXTS: readonly ConsentScopeMeta[] = [
  { scope: 'service_basic', title: '进入个人服务', summary: '查看你的健康计划、日历和记录' },
  { scope: 'health_processing', title: 'AI 处理健康信息', summary: '基于你的档案生成计划、整理记录' },
  { scope: 'photo_analysis', title: '餐食照片识别', summary: '识别你拍摄的餐食照片，结果由你确认' },
  { scope: 'team_access', title: '团队查看记录', summary: '专业团队查看你的记录与反馈，用于跟进' },
  { scope: 'reminder', title: '提醒触达', summary: '顾问按你的计划通过服务会话发送提醒' },
];

// ---------- 埋点白名单（契约数据模型 §3.15） ----------

export const H5_EVENT_WHITELIST: readonly string[] = [
  'h5.session_start',
  'h5.profile_step_complete',
  'h5.consent_decide',
  'h5.plan_view',
  'h5.plan_acknowledge',
  'h5.calendar_feedback',
  'h5.record_submit',
  'h5.article_view',
  'h5.followup_submit',
  'h5.reminder_pref_change',
];

// ---------- 持久化后端 ----------

export interface PatientH5Snapshot {
  invitations: InvitationRecord[];
  sessions: H5SessionRecord[];
  bindings: H5BindingRecord[];
  consents: ConsentRecord[];
  privacyRequests: PrivacyRequestRecord[];
}

export interface PatientH5Backend {
  load(): PatientH5Snapshot;
  loadIdempotency(patientId: string, key: string, now: number): Promise<unknown>;
  putInvitation(record: InvitationRecord): Promise<void>;
  putSession(record: H5SessionRecord): Promise<void>;
  putBinding(record: H5BindingRecord): Promise<void>;
  putConsent(record: ConsentRecord): Promise<void>;
  putPrivacyRequest(record: PrivacyRequestRecord): Promise<void>;
  appendAudit(record: H5AuditRecord): Promise<void>;
  appendEvent(record: H5EventRecord): Promise<void>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
}

/** 测试用内存后端 */
export class MemoryH5Backend implements PatientH5Backend {
  private readonly snapshot: PatientH5Snapshot = {
    invitations: [],
    sessions: [],
    bindings: [],
    consents: [],
    privacyRequests: [],
  };
  readonly audits: H5AuditRecord[] = [];
  readonly events: H5EventRecord[] = [];
  readonly idempotency: IdempotencyRecord[] = [];

  load(): PatientH5Snapshot {
    return {
      invitations: [...this.snapshot.invitations],
      sessions: [...this.snapshot.sessions],
      bindings: [...this.snapshot.bindings],
      consents: [...this.snapshot.consents],
      privacyRequests: [...this.snapshot.privacyRequests],
    };
  }

  async putInvitation(record: InvitationRecord): Promise<void> {
    this.upsert(this.snapshot.invitations, record, (item) => item.id === record.id);
  }

  async putSession(record: H5SessionRecord): Promise<void> {
    this.upsert(this.snapshot.sessions, record, (item) => item.id === record.id);
  }

  async putBinding(record: H5BindingRecord): Promise<void> {
    this.upsert(this.snapshot.bindings, record, (item) => item.id === record.id);
  }

  async putConsent(record: ConsentRecord): Promise<void> {
    this.upsert(this.snapshot.consents, record, (item) => item.id === record.id);
  }

  async putPrivacyRequest(record: PrivacyRequestRecord): Promise<void> {
    this.upsert(this.snapshot.privacyRequests, record, (item) => item.id === record.id);
  }

  async appendAudit(record: H5AuditRecord): Promise<void> {
    this.audits.push(record);
  }

  async appendEvent(record: H5EventRecord): Promise<void> {
    this.events.push(record);
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    this.idempotency.push(record);
  }

  async loadIdempotency(patientId: string, key: string, now: number): Promise<unknown> {
    const hit = this.idempotency.find(
      (item) =>
        item.patientId === patientId &&
        item.key === key &&
        now - item.at <= IDEMPOTENCY_WINDOW_MS,
    );
    return hit?.response;
  }

  private upsert<T>(list: T[], record: T, same: (item: T) => boolean): void {
    const index = list.findIndex(same);
    if (index >= 0) list[index] = record;
    else list.push(record);
  }
}

// ---------- 服务 ----------

interface VerifyCodeEntry {
  code: string;
  issuedAt: number;
  attempts: number;
}

export interface PatientH5ServiceOptions {
  tenantId: string;
  backend: PatientH5Backend;
  sms: SmsPort;
  /** 患者档案只读视图：PH5-02 只需要 status / displayName / advisorId */
  loadPatient: (
    patientId: string,
  ) => { status: string; displayName: string; advisorId?: string } | undefined;
  now?: () => number;
  ids?: IdFactory;
  invitationTtlMs?: number;
  sessionAbsoluteTtlMs?: number;
  sessionIdleTtlMs?: number;
  verifyCodeTtlMs?: number;
  /** invite_only 时关闭手机号免邀请登录（待决项 §12.1 的安全开关） */
  patientLoginMode?: 'invite_then_phone' | 'invite_only';
  consentTextsVersion?: number;
  consentTexts?: readonly ConsentScopeMeta[];
  retentionNotice?: string;
  /** 授权变化钩子：后续工作包（提醒/计划）用来执行取消传播（契约 §5） */
  onConsentChange?: (patientId: string, scope: ConsentScope, status: ConsentStatus) => void;
  onAudit?: (record: H5AuditRecord) => void;
}

const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VERIFY_CODE_TTL_MS = 5 * 60 * 1000;
const INVITATION_FAILURE_LIMIT = 5;
/** 同一验证码最多尝试次数；超过即作废（防枚举） */
const VERIFY_CODE_MAX_ATTEMPTS = 5;
/** 手机号登录失败上限与时间窗（防暴力猜码） */
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

function phoneTailOf(phone: string): string {
  return phone.slice(-4);
}

export function isValidPhone(phone: unknown): phone is string {
  return typeof phone === 'string' && /^1[3-9]\d{9}$/.test(phone);
}

/** 本地日期（Asia/Shanghai，契约 §1.2；v1 固定时区，待决项 §12.3） */
export function localDateKey(at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export interface SessionView {
  session: H5SessionRecord;
  patient: { status: string; displayName: string; advisorId?: string };
}

export interface RedeemResult {
  sessionToken: string;
  session: H5SessionRecord;
  binding: H5BindingRecord;
  meStatus: string;
}

export interface ConsentDecision {
  record: ConsentRecord;
  /** 是否真的发生了状态迁移（幂等重复决定时 false） */
  changed: boolean;
}

export class PatientH5Service {
  private readonly tenantId: string;
  private readonly backend: PatientH5Backend;
  private readonly sms: SmsPort;
  private readonly loadPatientRef: PatientH5ServiceOptions['loadPatient'];
  private readonly now: () => number;
  private readonly ids: IdFactory;
  private readonly invitationTtlMs: number;
  private readonly sessionAbsoluteTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly verifyCodeTtlMs: number;
  private readonly patientLoginMode: 'invite_then_phone' | 'invite_only';
  private readonly consentTextsVersion: number;
  private readonly consentTexts: readonly ConsentScopeMeta[];
  private readonly retentionNotice: string;
  private readonly onConsentChange?: (
    patientId: string,
    scope: ConsentScope,
    status: ConsentStatus,
  ) => void;
  private readonly onAudit?: (record: H5AuditRecord) => void;

  /** 验证码与失败计数是短时状态：进程内存即可（5 分钟 TTL，重启失效可接受） */
  private readonly verifyCodes = new Map<string, VerifyCodeEntry>();
  private readonly invitationFailures = new Map<string, number[]>();
  /** 手机号登录失败计数（同手机号 15 分钟 5 次），防暴力猜码 */
  private readonly loginFailures = new Map<string, number[]>();

  constructor(options: PatientH5ServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.sms = options.sms;
    this.loadPatientRef = options.loadPatient;
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? (() => {
      throw new H5Error('INTERNAL', 'id factory 未配置');
    });
    this.invitationTtlMs = options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS;
    this.sessionAbsoluteTtlMs =
      options.sessionAbsoluteTtlMs ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS;
    this.sessionIdleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.verifyCodeTtlMs = options.verifyCodeTtlMs ?? DEFAULT_VERIFY_CODE_TTL_MS;
    this.patientLoginMode = options.patientLoginMode ?? 'invite_then_phone';
    this.consentTextsVersion = options.consentTextsVersion ?? 1;
    this.consentTexts = options.consentTexts ?? DEFAULT_CONSENT_TEXTS;
    this.retentionNotice = options.retentionNotice ?? '按合同约定；当前演示环境不自动删除';
    this.onConsentChange = options.onConsentChange;
    this.onAudit = options.onAudit;
  }

  // ---------- 邀请 ----------

  async createInvitation(input: {
    patientId: string;
    advisorId: string;
    phone: string;
    ttlHours?: number;
    note?: string;
    createdBy: string;
  }): Promise<InvitationRecord> {
    const patient = this.loadPatientRef(input.patientId);
    if (!patient) throw new H5Error('NOT_FOUND', '患者不存在');
    if (patient.status !== 'serving') throw new H5Error('SERVICE_PAUSED', '患者当前不在服务中');
    if (!isValidPhone(input.phone)) {
      throw new H5Error('VALIDATION_FAILED', '手机号格式不正确', [
        { field: 'phone', issue: 'invalid phone' },
      ]);
    }
    const now = this.now();
    const ttl =
      input.ttlHours && input.ttlHours > 0 && input.ttlHours <= 72
        ? input.ttlHours * 60 * 60 * 1000
        : this.invitationTtlMs;
    const record: InvitationRecord = {
      id: this.ids('pinv'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      advisorId: input.advisorId,
      phone: input.phone,
      phoneTail: phoneTailOf(input.phone),
      code: newSessionToken(),
      status: 'pending',
      expiresAt: now + ttl,
      note: input.note?.slice(0, 200),
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.putInvitation(record);
    await this.audit({
      actorType: 'account',
      actorId: input.createdBy,
      action: 'h5.invitation.create',
      targetType: 'invitation',
      targetId: record.id,
      detail: { patientId: record.patientId, advisorId: record.advisorId, ttlHours: input.ttlHours },
    });
    return record;
  }

  listInvitations(patientId: string): InvitationRecord[] {
    const now = this.now();
    return this.backend
      .load()
      .invitations.filter((item) => item.tenantId === this.tenantId && item.patientId === patientId)
      .map((item) => this.withEffectiveStatus(item, now))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 过期是时间事实，不靠写入维护：`pending` 且已过 expiresAt 读取时派生为 `expired`。
   * 否则控制台会把失效邀请一直显示为「待使用」，顾问继续把死链发给患者。
   */
  private withEffectiveStatus(record: InvitationRecord, now: number): InvitationRecord {
    if (record.status === 'pending' && record.expiresAt <= now) {
      return { ...record, status: 'expired' };
    }
    return record;
  }

  /** 团队侧视图：永远不含 code 与完整手机号（契约 api §12.1） */
  invitationView(record: InvitationRecord): Omit<InvitationRecord, 'code' | 'phone'> {
    const { code: _code, phone: _phone, ...rest } = this.withEffectiveStatus(record, this.now());
    return rest;
  }

  async revokeInvitation(id: string, revokedBy: string): Promise<InvitationRecord> {
    const record = this.findInvitation(id);
    if (!record) throw new H5Error('NOT_FOUND', '邀请不存在');
    if (record.status !== 'pending') throw new H5Error('CONFLICT', '邀请不在待使用状态');
    const now = this.now();
    record.status = 'revoked';
    record.revokedAt = now;
    record.revokedBy = revokedBy;
    record.updatedAt = now;
    await this.backend.putInvitation(record);
    await this.audit({
      actorType: 'account',
      actorId: revokedBy,
      action: 'h5.invitation.revoke',
      targetType: 'invitation',
      targetId: record.id,
      result: 'success',
    });
    return record;
  }

  // ---------- 验证码 ----------

  /**
   * 发送验证码。兑换流程带 invitationCode（收件人 = 预绑定手机号）；
   * 再次登录流程只带 phone（收件人 = 绑定手机号）。
   * 手机号不进审计；响应只回 phoneTail。
   */
  async requestVerifyCode(input: {
    invitationCode?: string;
    phone?: string;
  }): Promise<{ phoneTail: string; expiresIn: number }> {
    if (this.sms.mode === 'unconfigured') {
      throw new H5Error('SMS_UNAVAILABLE', '短信通道未配置，真实登录暂不可用');
    }
    let phone: string | undefined;
    if (input.invitationCode) {
      const invitation = this.findInvitationByCode(input.invitationCode);
      if (!invitation || invitation.status !== 'pending') {
        // 不区分不存在/已使用/已撤销（契约 api §2.1）
        throw new H5Error('INVITATION_NOT_FOUND', '邀请不存在或已失效');
      }
      if (invitation.expiresAt <= this.now()) {
        throw new H5Error('INVITATION_EXPIRED', '邀请已过期，请联系顾问重新办理');
      }
      phone = invitation.phone;
    } else if (isValidPhone(input.phone)) {
      const binding = this.findBindingByPhone(input.phone);
      if (binding) phone = binding.phone;
    }
    if (!phone) throw new H5Error('VALIDATION_FAILED', '无法向该手机号发送验证码');

    const code = this.sms.mode === 'mock' ? MOCK_VERIFY_CODE : String(this.randomCode());
    const entry = this.verifyCodes.get(phone);
    const now = this.now();
    // 同手机号 1 条/分钟（简单节流：60 秒内不重复发）
    if (entry && now - entry.issuedAt < 60 * 1000) {
      throw new H5Error('RATE_LIMITED', '发送太频繁，请稍后再试');
    }
    this.verifyCodes.set(phone, { code, issuedAt: now, attempts: 0 });
    await this.sms.sendCode(phone, code);
    return { phoneTail: phoneTailOf(phone), expiresIn: Math.floor(this.verifyCodeTtlMs / 1000) };
  }

  private randomCode(): number {
    return Math.floor(100_000 + Math.random() * 900_000);
  }

  /**
   * 校验验证码。6 位码在 5 分钟有效期内只允许尝试 VERIFY_CODE_MAX_ATTEMPTS 次，
   * 超过即作废并要求重新获取——否则可被枚举（安全评审，禁用无限尝试）。
   */
  private verifyCode(phone: string, code: unknown): void {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new H5Error('VERIFY_CODE_INVALID', '验证码错误或已过期');
    }
    const entry = this.verifyCodes.get(phone);
    const now = this.now();
    if (!entry || now - entry.issuedAt > this.verifyCodeTtlMs) {
      throw new H5Error('VERIFY_CODE_INVALID', '验证码错误或已过期');
    }
    if (entry.attempts >= VERIFY_CODE_MAX_ATTEMPTS) {
      this.verifyCodes.delete(phone);
      throw new H5Error('RATE_LIMITED', '验证码尝试次数过多，请重新获取');
    }
    entry.attempts += 1;
    if (entry.code !== code) {
      throw new H5Error('VERIFY_CODE_INVALID', '验证码错误或已过期');
    }
    this.verifyCodes.delete(phone);
  }

  // ---------- 兑换与登录 ----------

  async redeem(input: {
    invitationCode: string;
    phone: string;
    code: string;
    userAgentSummary?: string;
  }): Promise<RedeemResult> {
    const invitation = this.findInvitationByCode(input.invitationCode);
    if (!invitation || invitation.status !== 'pending') {
      // 已使用/已撤销与不存在同错误，防探测（契约 api §2.2）
      throw new H5Error('INVITATION_NOT_FOUND', '邀请不存在或已失效');
    }
    if (invitation.expiresAt <= this.now()) {
      throw new H5Error('INVITATION_EXPIRED', '邀请已过期，请联系顾问重新办理');
    }
    this.failOnRateLimited(invitation.id);
    if (!isValidPhone(input.phone)) {
      throw new H5Error('VALIDATION_FAILED', '手机号格式不正确');
    }
    if (input.phone !== invitation.phone) {
      this.recordInvitationFailure(invitation.id);
      throw new H5Error('PHONE_MISMATCH', '手机号与邀请预留的不一致');
    }
    try {
      this.verifyCode(invitation.phone, input.code);
    } catch (error) {
      this.recordInvitationFailure(invitation.id);
      throw error;
    }
    const patient = this.loadPatientRef(invitation.patientId);
    if (!patient) throw new H5Error('NOT_FOUND', '患者不存在');
    if (patient.status !== 'serving') {
      // 服务暂停：邀请保持 pending（契约 §4.1）
      throw new H5Error('SERVICE_PAUSED', '服务已暂停，暂不能开通');
    }

    const now = this.now();
    const binding = await this.ensureBinding(invitation, now);
    const issued = await this.issueSession(binding.patientId, 'invite_sms', input.userAgentSummary);

    invitation.status = 'used';
    invitation.usedAt = now;
    invitation.usedSessionId = issued.record.id;
    invitation.updatedAt = now;
    await this.backend.putInvitation(invitation);

    await this.audit({
      actorType: 'patient',
      actorId: binding.patientId,
      action: 'h5.session.issue',
      targetType: 'session',
      targetId: issued.record.id,
      detail: { authMethod: 'invite_sms', invitationId: invitation.id },
    });
    await this.recordEvent(binding.patientId, 'h5.session_start', undefined, {
      loginMode: 'invite_sms',
    });
    return {
      sessionToken: issued.token,
      session: issued.record,
      binding,
      meStatus: this.meStatus(patient),
    };
  }

  async login(input: {
    phone: string;
    code: string;
    userAgentSummary?: string;
  }): Promise<RedeemResult> {
    if (this.patientLoginMode === 'invite_only') {
      throw new H5Error('FORBIDDEN', '当前配置仅支持邀请登录');
    }
    if (!isValidPhone(input.phone)) {
      throw new H5Error('VALIDATION_FAILED', '手机号格式不正确');
    }
    const binding = this.findBindingByPhone(input.phone);
    if (!binding || binding.status !== 'bound' || binding.tenantId !== this.tenantId) {
      // 不区分未绑定/不匹配（契约 api §2.4）
      throw new H5Error('UNAUTHORIZED', '手机号未开通，请使用邀请链接进入');
    }
    const patient = this.loadPatientRef(binding.patientId);
    if (!patient) throw new H5Error('UNAUTHORIZED', '手机号未开通，请使用邀请链接进入');
    if (patient.status !== 'serving') {
      throw new H5Error('SERVICE_PAUSED', '服务已暂停');
    }
    this.assertLoginNotLimited(binding.phone);
    try {
      this.verifyCode(binding.phone, input.code);
    } catch (error) {
      this.recordLoginFailure(binding.phone);
      throw error;
    }
    const issued = await this.issueSession(binding.patientId, 'phone_sms', input.userAgentSummary);
    await this.audit({
      actorType: 'patient',
      actorId: binding.patientId,
      action: 'h5.session.issue',
      targetType: 'session',
      targetId: issued.record.id,
      detail: { authMethod: 'phone_sms' },
    });
    await this.recordEvent(binding.patientId, 'h5.session_start', undefined, {
      loginMode: 'phone_sms',
    });
    return {
      sessionToken: issued.token,
      session: issued.record,
      binding,
      meStatus: this.meStatus(patient),
    };
  }

  /**
   * 建立或更新绑定。必须 await：绑定未落盘时不能返回兑换成功（否则重启后手机号登录查不到）。
   * 换号重绑：已有绑定但手机号不同时更新为新号；新号已被同租户其他患者占用则拒绝。
   */
  private async ensureBinding(
    invitation: InvitationRecord,
    now: number,
  ): Promise<H5BindingRecord> {
    const snapshot = this.backend.load();
    const occupied = snapshot.bindings.find(
      (item) =>
        item.tenantId === this.tenantId &&
        item.status === 'bound' &&
        item.phone === invitation.phone &&
        item.patientId !== invitation.patientId,
    );
    if (occupied) {
      throw new H5Error('CONFLICT', '该手机号已绑定其他服务对象，请联系顾问核对');
    }
    const existing = snapshot.bindings.find(
      (item) =>
        item.tenantId === this.tenantId &&
        item.patientId === invitation.patientId &&
        item.status === 'bound',
    );
    if (existing) {
      if (existing.phone !== invitation.phone) {
        const updated: H5BindingRecord = {
          ...existing,
          phone: invitation.phone,
          phoneTail: invitation.phoneTail,
          boundVia: invitation.id,
          unboundAt: undefined,
          unboundBy: undefined,
        };
        await this.backend.putBinding(updated);
        return updated;
      }
      return existing;
    }
    const record: H5BindingRecord = {
      id: this.ids('hbd'),
      tenantId: this.tenantId,
      patientId: invitation.patientId,
      phone: invitation.phone,
      phoneTail: invitation.phoneTail,
      status: 'bound',
      boundAt: now,
      boundVia: invitation.id,
    };
    await this.backend.putBinding(record);
    return record;
  }

  /** 返回 record（已持久化，不含令牌）+ token（明文，只进 Cookie，不落库） */
  private async issueSession(
    patientId: string,
    authMethod: SessionAuthMethod,
    userAgentSummary?: string,
  ): Promise<{ record: H5SessionRecord; token: string }> {
    const now = this.now();
    const token = newSessionToken();
    const record: H5SessionRecord = {
      id: this.ids('phs'),
      tenantId: this.tenantId,
      patientId,
      tokenHash: hashToken(token),
      authMethod,
      status: 'active',
      issuedAt: now,
      expiresAt: now + this.sessionAbsoluteTtlMs,
      lastSeenAt: now,
      ...(userAgentSummary ? { userAgentSummary: userAgentSummary.slice(0, 40) } : {}),
    };
    await this.backend.putSession(record);
    return { record, token };
  }

  // ---------- 会话 ----------

  /** 校验会话并滑动续期；返回 null 表示未通过（401） */
  async resolveSession(token: string | undefined): Promise<SessionView | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.backend
      .load()
      .sessions.find((item) => item.tenantId === this.tenantId && item.tokenHash === tokenHash);
    if (!session) return null;
    const now = this.now();
    if (session.status !== 'active') return null;
    if (session.expiresAt <= now) {
      await this.expireSession(session, now);
      return null;
    }
    if (now - session.lastSeenAt > this.sessionIdleTtlMs) {
      await this.expireSession(session, now);
      return null;
    }
    if (now - session.lastSeenAt > 60 * 1000) {
      const touched = this.clone(session);
      touched.lastSeenAt = now;
      await this.backend.putSession(touched);
      session.lastSeenAt = now;
    }
    const patient = this.loadPatientRef(session.patientId);
    if (!patient) return null;
    return { session, patient };
  }

  async revokeSession(
    sessionId: string,
    by: 'patient' | 'account' | 'system',
    byId?: string,
  ): Promise<void> {
    const found = this.backend
      .load()
      .sessions.find((item) => item.tenantId === this.tenantId && item.id === sessionId);
    if (!found || found.status !== 'active') return;
    const session = this.clone(found);
    const now = this.now();
    session.status = 'revoked';
    session.revokedAt = now;
    session.revokedBy = by;
    session.revokedById = byId;
    await this.backend.putSession(session);
    await this.audit({
      actorType: by === 'account' ? 'account' : by === 'patient' ? 'patient' : 'system',
      actorId: byId,
      action: 'h5.session.revoke',
      targetType: 'session',
      targetId: session.id,
      detail: { by },
    });
  }

  async logout(token: string): Promise<void> {
    const resolved = await this.resolveSession(token);
    if (resolved) await this.revokeSession(resolved.session.id, 'patient');
  }

  listSessions(patientId: string): H5SessionRecord[] {
    return this.backend
      .load()
      .sessions.filter(
        (item) => item.tenantId === this.tenantId && item.patientId === patientId,
      )
      .sort((a, b) => b.issuedAt - a.issuedAt);
  }

  getBinding(patientId: string): H5BindingRecord | undefined {
    return this.backend
      .load()
      .bindings.find(
        (item) => item.tenantId === this.tenantId && item.patientId === patientId,
      );
  }

  private async expireSession(record: H5SessionRecord, now: number): Promise<void> {
    const session = this.clone(record);
    session.status = 'expired';
    session.lastSeenAt = now;
    await this.backend.putSession(session);
  }

  // ---------- 授权 ----------

  consentOverview(patientId: string): {
    textsVersion: number;
    items: Array<ConsentRecord & ConsentScopeMeta>;
  } {
    const records = new Map(
      this.backend
        .load()
        .consents.filter((item) => item.tenantId === this.tenantId && item.patientId === patientId)
        .map((item) => [item.scope, item]),
    );
    const now = this.now();
    const items = this.consentTexts.map((meta) => {
      const record = records.get(meta.scope);
      if (record) return { ...meta, ...record };
      return {
        id: '',
        tenantId: this.tenantId,
        patientId,
        status: 'never' as ConsentStatus,
        version: this.consentTextsVersion,
        history: [],
        updatedAt: now,
        ...meta,
      };
    });
    return { textsVersion: this.consentTextsVersion, items };
  }

  async decideConsent(input: {
    patientId: string;
    scope: ConsentScope;
    action: 'grant' | 'withdraw';
    decidedVia: string;
  }): Promise<ConsentDecision> {
    if (!CONSENT_SCOPES.includes(input.scope)) {
      throw new H5Error('VALIDATION_FAILED', '未知的授权范围', [
        { field: 'scope', issue: 'unknown scope' },
      ]);
    }
    const now = this.now();
    const found = this.backend
      .load()
      .consents.find(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === input.patientId &&
          item.scope === input.scope,
      );
    const targetStatus: ConsentStatus = input.action === 'grant' ? 'granted' : 'withdrawn';
    const current = found?.status ?? 'never';
    const changed = current !== targetStatus;

    // 存储对象不得原地修改：已有记录改克隆体，新记录直接构造（存储域约定）
    const record: ConsentRecord = found
      ? this.clone(found)
      : {
          id: this.ids('pcon'),
          tenantId: this.tenantId,
          patientId: input.patientId,
          scope: input.scope,
          status: current,
          version: this.consentTextsVersion,
          history: [],
          updatedAt: now,
        };

    if (changed) {
      record.status = targetStatus;
      record.version = this.consentTextsVersion;
      record.history = [
        ...record.history,
        { action: input.action, at: now, version: this.consentTextsVersion, via: input.decidedVia },
      ];
      record.updatedAt = now;
      record.decidedVia = input.decidedVia;
      if (input.action === 'grant') record.grantedAt = now;
      else record.withdrawnAt = now;
      await this.backend.putConsent(record);
    }

    // 审计：首次决定与重复同向决定都记（重复决定 changed=false，便于排查）
    await this.audit({
      actorType: 'patient',
      actorId: input.patientId,
      action: input.action === 'grant' ? 'h5.consent.grant' : 'h5.consent.withdraw',
      targetType: 'consent',
      targetId: record.id,
      detail: { scope: input.scope, version: this.consentTextsVersion, changed },
    });

    if (changed) {
      // 埋点只由服务端写一次，前端不再重复上报（避免重复计数）
      await this.recordEvent(input.patientId, 'h5.consent_decide', undefined, {
        scope: input.scope,
        action: input.action,
      });
      // 取消传播（契约 §5）：service_basic 撤回 → 撤销全部会话；其余交给钩子
      if (input.scope === 'service_basic' && targetStatus === 'withdrawn') {
        for (const session of this.listSessions(input.patientId)) {
          if (session.status === 'active') {
            await this.revokeSession(session.id, 'system');
          }
        }
      }
      this.onConsentChange?.(input.patientId, input.scope, targetStatus);
    }
    return { record, changed };
  }

  /** 契约 §6.2 的 scope 门控：供路由层与后续包复用 */
  consentStatus(patientId: string, scope: ConsentScope): ConsentStatus {
    const record = this.backend
      .load()
      .consents.find(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === patientId &&
          item.scope === scope,
      );
    return record?.status ?? 'never';
  }

  consentsView(patientId: string): Record<string, ConsentStatus> {
    const view: Record<string, ConsentStatus> = {};
    for (const scope of CONSENT_SCOPES) view[scope] = this.consentStatus(patientId, scope);
    return view;
  }

  // ---------- 隐私申请 ----------

  privacySummary(patientId: string): {
    retentionNotice: string;
    requests: PrivacyRequestRecord[];
    teamAccessScopes: ConsentScope[];
  } {
    const requests = this.backend
      .load()
      .privacyRequests.filter(
        (item) => item.tenantId === this.tenantId && item.patientId === patientId,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    const teamAccessScopes = CONSENT_SCOPES.filter((scope) =>
      scope === 'health_processing' || scope === 'team_access'
        ? this.consentStatus(patientId, scope) === 'granted'
        : false,
    );
    return { retentionNotice: this.retentionNotice, requests, teamAccessScopes };
  }

  async createPrivacyRequest(input: {
    patientId: string;
    kind: PrivacyRequestKind;
    targetType?: string;
    targetId?: string;
    detail: string;
    idempotencyKey?: string;
  }): Promise<PrivacyRequestRecord> {
    if (input.kind === 'correction' && (!input.targetType || !input.targetId)) {
      throw new H5Error('VALIDATION_FAILED', '纠错申请必须指定对象', [
        { field: 'targetId', issue: 'required for correction' },
      ]);
    }
    if (typeof input.detail !== 'string' || input.detail.length > 300) {
      throw new H5Error('VALIDATION_FAILED', '申请说明最多 300 字');
    }
    if (input.idempotencyKey) {
      const existing = await this.backend.loadIdempotency(
        input.patientId,
        input.idempotencyKey,
        this.now(),
      );
      if (existing) return existing as PrivacyRequestRecord;
    }
    const now = this.now();
    const record: PrivacyRequestRecord = {
      id: this.ids('prq'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      kind: input.kind,
      ...(input.targetType ? { targetType: input.targetType } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      detail: input.detail,
      status: 'submitted',
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.putPrivacyRequest(record);
    if (input.idempotencyKey) {
      await this.backend.putIdempotency({
        key: input.idempotencyKey,
        tenantId: this.tenantId,
        patientId: input.patientId,
        endpoint: 'privacy.requests',
        response: record,
        at: now,
      });
    }
    await this.audit({
      actorType: 'patient',
      actorId: input.patientId,
      action: 'h5.privacy.request',
      targetType: 'privacy_request',
      targetId: record.id,
      detail: { kind: record.kind },
    });
    return record;
  }

  listPrivacyRequests(status?: PrivacyRequestStatus): PrivacyRequestRecord[] {
    return this.backend
      .load()
      .privacyRequests.filter(
        (item) => item.tenantId === this.tenantId && (!status || item.status === status),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async handlePrivacyRequest(input: {
    id: string;
    result: 'handled' | 'rejected';
    note: string;
    handledBy: string;
  }): Promise<PrivacyRequestRecord> {
    const found = this.backend
      .load()
      .privacyRequests.find((item) => item.tenantId === this.tenantId && item.id === input.id);
    if (!found) throw new H5Error('NOT_FOUND', '申请不存在');
    if (found.status !== 'submitted') throw new H5Error('CONFLICT', '申请已处理');
    const record = this.clone(found);
    const now = this.now();
    record.status = input.result;
    record.handledBy = input.handledBy;
    record.handledAt = now;
    record.resultNote = input.note.slice(0, 500);
    record.updatedAt = now;
    await this.backend.putPrivacyRequest(record);
    await this.audit({
      actorType: 'account',
      actorId: input.handledBy,
      action: 'h5.privacy.handle',
      targetType: 'privacy_request',
      targetId: record.id,
      detail: { result: input.result, kind: record.kind },
    });
    return record;
  }

  // ---------- /me 与埋点 ----------

  /** PH5-02 最小状态机；PH5-03（建档）/PH5-04（计划）通过 override 扩展 */
  meStatus(patient: { status: string }): string {
    if (patient.status !== 'serving') return 'service_paused';
    return 'profile_incomplete';
  }

  async recordEvent(
    patientId: string,
    event: string,
    itemId?: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (!H5_EVENT_WHITELIST.includes(event)) {
      throw new H5Error('VALIDATION_FAILED', '未知事件', [{ field: 'event', issue: 'not whitelisted' }]);
    }
    await this.backend.appendEvent({
      id: this.ids('evt'),
      tenantId: this.tenantId,
      patientId,
      event,
      ...(itemId ? { itemId: itemId.slice(0, 64) } : {}),
      ...(typeof extra?.durationMs === 'number' ? { durationMs: extra.durationMs } : {}),
      at: this.now(),
    });
  }

  // ---------- 内部 ----------

  /** 存储返回的是介质里的对象本身，不得原地修改；改前先克隆（存储域约定） */
  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private findInvitation(id: string): InvitationRecord | undefined {
    const found = this.backend
      .load()
      .invitations.find((item) => item.tenantId === this.tenantId && item.id === id);
    return found ? this.clone(found) : undefined;
  }

  private findInvitationByCode(code: string): InvitationRecord | undefined {
    const found = this.backend
      .load()
      .invitations.find((item) => item.tenantId === this.tenantId && item.code === code);
    return found ? this.clone(found) : undefined;
  }

  private findBindingByPhone(phone: string): H5BindingRecord | undefined {
    const found = this.backend
      .load()
      .bindings.find(
        (item) => item.tenantId === this.tenantId && item.status === 'bound' && item.phone === phone,
      );
    return found ? this.clone(found) : undefined;
  }

  private assertLoginNotLimited(phone: string): void {
    const now = this.now();
    const failures = (this.loginFailures.get(phone) ?? []).filter(
      (at) => now - at < LOGIN_FAILURE_WINDOW_MS,
    );
    this.loginFailures.set(phone, failures);
    if (failures.length >= LOGIN_FAILURE_LIMIT) {
      throw new H5Error('RATE_LIMITED', '登录尝试次数过多，请 15 分钟后再试');
    }
  }

  private recordLoginFailure(phone: string): void {
    const now = this.now();
    const failures = (this.loginFailures.get(phone) ?? []).filter(
      (at) => now - at < LOGIN_FAILURE_WINDOW_MS,
    );
    failures.push(now);
    this.loginFailures.set(phone, failures);
  }

  private failOnRateLimited(invitationId: string): void {
    const now = this.now();
    const failures = (this.invitationFailures.get(invitationId) ?? []).filter(
      (at) => now - at < 15 * 60 * 1000,
    );
    if (failures.length >= INVITATION_FAILURE_LIMIT) {
      throw new H5Error('RATE_LIMITED', '尝试次数过多，邀请已锁定，请联系顾问');
    }
    this.invitationFailures.set(invitationId, failures);
  }

  private recordInvitationFailure(invitationId: string): void {
    const now = this.now();
    const failures = (this.invitationFailures.get(invitationId) ?? []).filter(
      (at) => now - at < 15 * 60 * 1000,
    );
    failures.push(now);
    this.invitationFailures.set(invitationId, failures);
  }

  private async audit(input: {
    actorType: H5AuditRecord['actorType'];
    actorId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    result?: 'success' | 'failure';
    detail?: Record<string, unknown>;
    errorCode?: string;
  }): Promise<void> {
    const record: H5AuditRecord = {
      id: this.ids('aud'),
      tenantId: this.tenantId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result ?? 'success',
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      at: this.now(),
    };
    await this.backend.appendAudit(record);
    this.onAudit?.(record);
  }
}
