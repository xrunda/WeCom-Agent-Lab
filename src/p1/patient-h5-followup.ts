/**
 * PH5-07（#236）患者端 H5：跟进请求的创建、认领、处理与超时升级。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.10、§4.4；docs/PATIENT-H5-api.md §8、§12.3。
 *
 * 四条容易做错的规则：
 * 1. **自动回执 ≠ 处理**：autoAckSentAt 只表示系统说了一声「已收到」，
 *    首次人工响应必须看 claimedAt（A11）
 * 2. **无责任人不能烂尾**：超过 SLA 未认领要升级给主管，而不是永远挂着
 * 3. **高风险不让患者等留言**：风险类请求直接提示就医，系统不生成疾病解释
 * 4. **范围隔离**：scope=self 的账号只能处理名下患者的请求
 */
import type { IdFactory } from './ids.ts';

export type FollowupKind =
  | 'question'
  | 'need_help'
  | 'plan_adjust'
  | 'risk'
  | 'profile_correction'
  | 'record_flag';

export type FollowupStatus = 'pending' | 'claimed' | 'resolved';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface FollowupRecord {
  id: string;
  tenantId: string;
  patientId: string;
  kind: FollowupKind;
  message: string;
  linkedPlanId?: string;
  linkedPlanVersion?: number;
  linkedCalendarItemId?: string;
  linkedRecordId?: string;
  riskLevel: RiskLevel;
  status: FollowupStatus;
  assigneeAccountId?: string;
  assigneeName?: string;
  claimedAt?: number;
  resolvedAt?: number;
  resolutionNote?: string;
  slaDueAt: number;
  escalatedAt?: number;
  escalatedTo?: string;
  autoAckSentAt?: number;
  closedByPatient?: boolean;
  createdAt: number;
  updatedAt: number;
}

export class FollowupError extends Error {
  readonly code: 'NOT_FOUND' | 'VALIDATION_FAILED' | 'FOLLOWUP_CLOSED' | 'FORBIDDEN';

  constructor(code: FollowupError['code'], message: string) {
    super(message);
    this.name = 'FollowupError';
    this.code = code;
  }
}

export interface FollowupBackend {
  load(): FollowupRecord[];
  put(record: FollowupRecord): Promise<void>;
}

export class MemoryFollowupBackend implements FollowupBackend {
  private readonly records: FollowupRecord[] = [];

  load(): FollowupRecord[] {
    return [...this.records];
  }

  async put(record: FollowupRecord): Promise<void> {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }
}

/** SLA：不同 kind 与风险等级给不同时限（可由配置覆盖） */
export interface SlaPolicy {
  defaultMinutes: number;
  riskMinutes: number;
  highRiskMinutes: number;
}

export const DEFAULT_SLA: SlaPolicy = {
  defaultMinutes: 24 * 60,
  riskMinutes: 4 * 60,
  highRiskMinutes: 60,
};

export interface FollowupServiceOptions {
  tenantId: string;
  backend: FollowupBackend;
  ids: IdFactory;
  now?: () => number;
  sla?: SlaPolicy;
  /** 主管账号（超时升级对象）；未配置时只在列表里标 overdue，不假装已升级 */
  supervisorAccountId?: string;
  onAudit?: (event: { action: string; followupId: string; detail?: Record<string, unknown> }) => void;
}

export interface FollowupView {
  id: string;
  kind: FollowupKind;
  message: string;
  riskLevel: RiskLevel;
  status: FollowupStatus;
  assigneeName: string | null;
  claimedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  slaDueAt: number;
  overdue: boolean;
  escalated: boolean;
}

function toView(record: FollowupRecord, now: number): FollowupView {
  return {
    id: record.id,
    kind: record.kind,
    message: record.message,
    riskLevel: record.riskLevel,
    status: record.status,
    assigneeName: record.assigneeName ?? null,
    claimedAt: record.claimedAt ?? null,
    resolvedAt: record.resolvedAt ?? null,
    createdAt: record.createdAt,
    slaDueAt: record.slaDueAt,
    overdue: record.status === 'pending' && now > record.slaDueAt,
    escalated: Boolean(record.escalatedAt),
  };
}

export class FollowupService {
  private readonly tenantId: string;
  private readonly backend: FollowupBackend;
  private readonly ids: IdFactory;
  private readonly now: () => number;
  private readonly sla: SlaPolicy;
  private readonly supervisorAccountId?: string;
  private readonly onAudit?: FollowupServiceOptions['onAudit'];

  constructor(options: FollowupServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.ids = options.ids;
    this.now = options.now ?? Date.now;
    this.sla = options.sla ?? DEFAULT_SLA;
    this.supervisorAccountId = options.supervisorAccountId;
    this.onAudit = options.onAudit;
  }

  /** 新建请求。患者提交后系统会发「已收到」，但那不是处理。 */
  async create(input: {
    patientId: string;
    kind: FollowupKind;
    message: string;
    riskLevel?: RiskLevel;
    linkedPlanId?: string;
    linkedPlanVersion?: number;
    linkedCalendarItemId?: string;
    linkedRecordId?: string;
  }): Promise<FollowupRecord> {
    const message = input.message?.trim();
    if (!message) {
      throw new FollowupError('VALIDATION_FAILED', '请填写说明');
    }
    const now = this.now();
    const riskLevel: RiskLevel =
      input.kind === 'risk' ? (input.riskLevel ?? 'high') : (input.riskLevel ?? 'low');
    const record: FollowupRecord = {
      id: this.ids('fup'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      kind: input.kind,
      message: message.slice(0, 500),
      ...(input.linkedPlanId ? { linkedPlanId: input.linkedPlanId } : {}),
      ...(input.linkedPlanVersion !== undefined
        ? { linkedPlanVersion: input.linkedPlanVersion }
        : {}),
      ...(input.linkedCalendarItemId ? { linkedCalendarItemId: input.linkedCalendarItemId } : {}),
      ...(input.linkedRecordId ? { linkedRecordId: input.linkedRecordId } : {}),
      riskLevel,
      status: 'pending',
      slaDueAt: now + this.slaFor(riskLevel) * 60 * 1000,
      autoAckSentAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.put(record);
    this.onAudit?.({ action: 'h5.followup.submit', followupId: record.id, detail: { kind: record.kind } });
    return record;
  }

  listForPatient(patientId: string): FollowupView[] {
    const now = this.now();
    return this.backend
      .load()
      .filter((item) => item.tenantId === this.tenantId && item.patientId === patientId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => toView(item, now));
  }

  getForPatient(patientId: string, id: string): FollowupView {
    const record = this.find(patientId, id);
    if (!record) throw new FollowupError('NOT_FOUND', '请求不存在');
    return toView(record, this.now());
  }

  /** 团队队列：scope 由调用方按账号数据范围收窄 */
  listForTeam(query: {
    status?: FollowupStatus;
    patientIds?: string[];
  } = {}): FollowupView[] {
    const now = this.now();
    return this.backend
      .load()
      .filter((item) => item.tenantId === this.tenantId)
      .filter((item) => (query.status ? item.status === query.status : true))
      .filter((item) => (query.patientIds ? query.patientIds.includes(item.patientId) : true))
      .sort((a, b) => {
        // 超时未认领的最先，其次按 SLA 到期时间
        const aOverdue = a.status === 'pending' ? 1 : 0;
        const bOverdue = b.status === 'pending' ? 1 : 0;
        if (aOverdue !== bOverdue) return bOverdue - aOverdue;
        return a.slaDueAt - b.slaDueAt;
      })
      .map((item) => toView(item, now));
  }

  unresolvedCount(patientIds?: string[]): { pending: number; overdue: number } {
    const now = this.now();
    const pending = this.backend
      .load()
      .filter((item) => item.tenantId === this.tenantId && item.status !== 'resolved')
      .filter((item) => (patientIds ? patientIds.includes(item.patientId) : true));
    return {
      pending: pending.length,
      overdue: pending.filter((item) => item.status === 'pending' && now > item.slaDueAt).length,
    };
  }

  /** 认领 = 首次人工响应时间；并发认领只有一个成功 */
  async claim(input: { id: string; accountId: string; accountName: string }): Promise<FollowupView> {
    const record = this.findById(input.id);
    if (!record) throw new FollowupError('NOT_FOUND', '请求不存在');
    if (record.status === 'resolved') throw new FollowupError('FOLLOWUP_CLOSED', '请求已处理');
    if (record.status === 'claimed') throw new FollowupError('FOLLOWUP_CLOSED', '请求已被他人认领');
    const now = this.now();
    record.status = 'claimed';
    record.assigneeAccountId = input.accountId;
    record.assigneeName = input.accountName;
    record.claimedAt = now;
    record.updatedAt = now;
    await this.backend.put(record);
    this.onAudit?.({ action: 'h5.followup.claim', followupId: record.id });
    return toView(record, now);
  }

  async resolve(input: {
    id: string;
    accountId: string;
    note: string;
  }): Promise<FollowupView> {
    const record = this.findById(input.id);
    if (!record) throw new FollowupError('NOT_FOUND', '请求不存在');
    if (record.status === 'resolved') throw new FollowupError('FOLLOWUP_CLOSED', '请求已处理');
    const now = this.now();
    record.status = 'resolved';
    record.resolvedAt = now;
    record.resolutionNote = input.note.slice(0, 500);
    record.assigneeAccountId = record.assigneeAccountId ?? input.accountId;
    record.claimedAt = record.claimedAt ?? now; // 直接处理也算人工响应
    record.updatedAt = now;
    await this.backend.put(record);
    this.onAudit?.({ action: 'h5.followup.resolve', followupId: record.id });
    return toView(record, now);
  }

  /**
   * 超时升级：把过期未认领的请求交给主管。
   * 没有配置主管时**不写 escalatedTo**，只在视图里标 overdue，不假装已经升级。
   */
  async escalateOverdue(): Promise<{ escalated: string[]; stillUnassigned: string[] }> {
    const now = this.now();
    const escalated: string[] = [];
    const stillUnassigned: string[] = [];
    for (const record of this.backend.load()) {
      if (record.tenantId !== this.tenantId) continue;
      if (record.status !== 'pending' || record.escalatedAt) continue;
      if (now <= record.slaDueAt) continue;
      if (!this.supervisorAccountId) {
        stillUnassigned.push(record.id);
        continue;
      }
      record.escalatedAt = now;
      record.escalatedTo = this.supervisorAccountId;
      record.updatedAt = now;
      await this.backend.put(record);
      escalated.push(record.id);
      this.onAudit?.({ action: 'h5.followup.escalate', followupId: record.id });
    }
    return { escalated, stillUnassigned };
  }

  /** 患者主动撤销 */
  async closeByPatient(patientId: string, id: string): Promise<FollowupView> {
    const record = this.find(patientId, id);
    if (!record) throw new FollowupError('NOT_FOUND', '请求不存在');
    if (record.status === 'resolved') throw new FollowupError('FOLLOWUP_CLOSED', '请求已处理');
    const now = this.now();
    record.status = 'resolved';
    record.closedByPatient = true;
    record.resolvedAt = now;
    record.updatedAt = now;
    await this.backend.put(record);
    return toView(record, now);
  }

  findById(id: string): FollowupRecord | undefined {
    const found = this.backend
      .load()
      .find((item) => item.tenantId === this.tenantId && item.id === id);
    return found ? (JSON.parse(JSON.stringify(found)) as FollowupRecord) : undefined;
  }

  find(patientId: string, id: string): FollowupRecord | undefined {
    const found = this.backend
      .load()
      .find((item) => item.tenantId === this.tenantId && item.patientId === patientId && item.id === id);
    return found ? (JSON.parse(JSON.stringify(found)) as FollowupRecord) : undefined;
  }

  private slaFor(riskLevel: RiskLevel): number {
    if (riskLevel === 'high') return this.sla.highRiskMinutes;
    if (riskLevel === 'medium') return this.sla.riskMinutes;
    return this.sla.defaultMinutes;
  }
}
