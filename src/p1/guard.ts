/**
 * #37 健康红线门禁：规则存储、关键词后校验、风险分级与升级告警。
 *
 * 设计约定：
 * - 内置四条红线（不诊断 / 不调药 / 不承诺疗效 / 急症只引导就医）只读，
 *   全部参与草稿后校验；急症规则同时检查患者输入，确保模型不重复症状也能升级。
 * - 命中的风险等级取「模型自评」与「规则等级」的较高者，不阻断推送。
 * - 急症（action=escalate）与只引导就医（action=guide）会改写草稿正文，
 *   只保留就医引导；action=flag 只抬高风险，正文交给顾问审核。
 * - 审计、告警与事件都不带消息正文与草稿正文，只带规则 id、名称和等级。
 */
import type { RiskLevel } from '../c2/types.ts';
import type { AuditEvent } from '../c2/types.ts';

export type RuleKind = 'redline' | 'keyword';
export type RuleAction = 'flag' | 'guide' | 'escalate';

export interface RiskRuleRecord {
  id: string;
  tenantId: string;
  kind: RuleKind;
  name: string;
  keywords: string[];
  riskLevel: RiskLevel;
  action: RuleAction;
  enabled: boolean;
  builtin: boolean;
  hitCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RiskRuleCreateInput {
  name: string;
  keywords: string[];
  riskLevel: RiskLevel;
  action?: RuleAction;
  enabled?: boolean;
}

export interface RiskRuleUpdateInput {
  name?: string;
  keywords?: string[];
  riskLevel?: RiskLevel;
  action?: RuleAction;
  enabled?: boolean;
}

export interface GuardAlertRecord {
  id: string;
  tenantId: string;
  kind: 'redline' | 'escalate';
  severity: 'warning' | 'critical';
  status: 'open';
  title: string;
  message: string;
  /** 草稿入队后回填，便于控制台从告警跳到草稿 */
  draftId?: string;
  patientId?: string;
  groupId?: string;
  sessionId?: string;
  ruleIds: string[];
  createdAt: number;
  updatedAt: number;
  sandbox: boolean;
}

export const ESCALATE_REASONS = ['emergency_symptom', 'patient_request', 'other'] as const;
export type EscalateReason = (typeof ESCALATE_REASONS)[number];

export const ESCALATE_REASON_LABEL: Record<EscalateReason, string> = {
  emergency_symptom: '急症症状',
  patient_request: '患者要求人工',
  other: '其他原因',
};

export interface GuardBackend {
  loadRules(): RiskRuleRecord[];
  loadAlerts(): GuardAlertRecord[];
  putRule(rule: RiskRuleRecord): Promise<void>;
  deleteRule(id: string): Promise<void>;
  putAlert(alert: GuardAlertRecord): Promise<void>;
}

export interface DraftReviewInput {
  body: string;
  riskLevel: RiskLevel;
  patientId: string;
  groupId?: string;
  sessionId?: string;
  source: 'inbound' | 'proactive';
  /** 本轮患者输入摘要；急症 / 就医引导规则会同时检查它 */
  inboundText?: string;
}

export interface DraftReviewResult {
  riskLevel: RiskLevel;
  /** 命中的规则 id，按规则顺序 */
  hits: string[];
  hitNames: string[];
  actions: RuleAction[];
  escalate: boolean;
  guideOnly: boolean;
  /** 需要改写草稿时使用的就医引导正文 */
  referralBody?: string;
  /** 本次校验产生的告警 id（未告警时为空） */
  alertId?: string;
}

export const REFERRAL_BODY =
  '您描述的情况需要尽快由医生处理。请立即拨打 120 或前往最近医院急诊，不要等待线上回复。';

export const RISK_RULE_NAME_MAX = 40;
export const RISK_KEYWORD_MAX = 30;
export const RISK_KEYWORDS_MAX = 20;

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export type GuardErrorCode =
  | 'EMPTY_NAME'
  | 'NAME_TOO_LONG'
  | 'EMPTY_KEYWORDS'
  | 'TOO_MANY_KEYWORDS'
  | 'INVALID_KEYWORD'
  | 'INVALID_RISK_LEVEL'
  | 'INVALID_ACTION'
  | 'INVALID_KIND'
  | 'NOT_FOUND'
  | 'IMMUTABLE_RESOURCE'
  | 'INVALID_REASON';

export class GuardError extends Error {
  readonly code: GuardErrorCode;

  constructor(code: GuardErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GuardError';
    this.code = code;
  }
}

function defaultId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function assertName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GuardError('EMPTY_NAME', 'name 不能为空');
  }
  const name = value.trim();
  if (name.length > RISK_RULE_NAME_MAX) {
    throw new GuardError('NAME_TOO_LONG', `name 不能超过 ${RISK_RULE_NAME_MAX} 字`);
  }
  return name;
}

function assertKeywords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GuardError('EMPTY_KEYWORDS', 'keywords 至少一个');
  }
  if (value.length > RISK_KEYWORDS_MAX) {
    throw new GuardError('TOO_MANY_KEYWORDS', `keywords 最多 ${RISK_KEYWORDS_MAX} 个`);
  }
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new GuardError('INVALID_KEYWORD', 'keyword 必须是字符串');
    const keyword = item.trim();
    if (keyword === '' || keyword.length > RISK_KEYWORD_MAX) {
      throw new GuardError('INVALID_KEYWORD', `keyword 长度需为 1–${RISK_KEYWORD_MAX} 字`);
    }
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  return keywords;
}

function assertRiskLevel(value: unknown): RiskLevel {
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new GuardError('INVALID_RISK_LEVEL', 'riskLevel 必须是 low/medium/high');
  }
  return value;
}

function assertAction(value: unknown): RuleAction {
  if (value !== 'flag' && value !== 'guide' && value !== 'escalate') {
    throw new GuardError('INVALID_ACTION', 'action 必须是 flag/guide/escalate');
  }
  return value;
}

function assertReason(value: unknown): EscalateReason {
  if (!ESCALATE_REASONS.includes(value as EscalateReason)) {
    throw new GuardError('INVALID_REASON', `reason 必须是 ${ESCALATE_REASONS.join('/')}`);
  }
  return value as EscalateReason;
}

/** 内置规则；tenantId 由服务注入，id 固定便于审计与界面识别 */
export function builtinRules(tenantId: string, at: number): RiskRuleRecord[] {
  const base = { tenantId, enabled: true, builtin: true, hitCount: 0, createdAt: at, updatedAt: at };
  return [
    {
      ...base,
      id: 'rul_builtin_no_diagnosis',
      kind: 'redline',
      name: '不诊断',
      keywords: ['诊断', '确诊', '病情判断'],
      riskLevel: 'high',
      action: 'flag',
    },
    {
      ...base,
      id: 'rul_builtin_no_medication',
      kind: 'redline',
      name: '不调药',
      keywords: ['停药', '减药', '加量', '换药'],
      riskLevel: 'high',
      action: 'flag',
    },
    {
      ...base,
      id: 'rul_builtin_no_efficacy',
      kind: 'redline',
      name: '不承诺疗效',
      keywords: ['保证', '根治', '包治', '一定能好'],
      riskLevel: 'high',
      action: 'flag',
    },
    {
      ...base,
      id: 'rul_builtin_emergency',
      kind: 'redline',
      name: '急症只引导就医',
      keywords: [
        '胸痛',
        '胸口很痛',
        '胸口疼',
        '呼吸困难',
        '喘不上气',
        '昏迷',
        '意识不清',
        '大出血',
        '晕厥',
        '抽搐',
      ],
      riskLevel: 'high',
      action: 'escalate',
    },
  ];
}

export interface GuardServiceOptions {
  tenantId: string;
  backend: GuardBackend;
  sandbox?: boolean;
  now?: () => number;
  newId?: (prefix: string) => string;
  onPersistError?: (error: Error) => void;
  onAudit?: (event: AuditEvent) => void;
  emit?: (type: string, data: unknown) => void;
}

export class GuardService {
  private readonly tenantId: string;
  private readonly backend: GuardBackend;
  private readonly sandbox: boolean;
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly onPersistError?: (error: Error) => void;
  private readonly onAudit?: (event: AuditEvent) => void;
  private readonly emit: (type: string, data: unknown) => void;

  private readonly rules = new Map<string, RiskRuleRecord>();
  private readonly alertLog: GuardAlertRecord[] = [];
  private readonly auditLog: AuditEvent[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(options: GuardServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.sandbox = options.sandbox ?? false;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.newId ?? defaultId;
    this.onPersistError = options.onPersistError;
    this.onAudit = options.onAudit;
    this.emit = options.emit ?? (() => undefined);

    for (const rule of options.backend.loadRules()) this.rules.set(rule.id, rule);
    for (const alert of options.backend.loadAlerts()) this.alertLog.push(alert);

    // 内置规则不可删：领域里缺哪条就补哪条（首次启动即写入）
    for (const rule of builtinRules(this.tenantId, this.now())) {
      if (!this.rules.has(rule.id)) {
        this.rules.set(rule.id, rule);
        this.persistRule(rule);
      }
    }
  }

  // ---------- 规则 ----------

  list(query: { kind?: RuleKind; enabled?: boolean } = {}): RiskRuleRecord[] {
    return [...this.rules.values()]
      .filter((rule) => (query.kind ? rule.kind === query.kind : true))
      .filter((rule) => (query.enabled === undefined ? true : rule.enabled === query.enabled))
      .sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  }

  get(id: string): RiskRuleRecord | undefined {
    return this.rules.get(id);
  }

  create(input: RiskRuleCreateInput): RiskRuleRecord {
    const name = assertName(input.name);
    const keywords = assertKeywords(input.keywords);
    const riskLevel = assertRiskLevel(input.riskLevel);
    const action = input.action === undefined ? 'flag' : assertAction(input.action);
    const at = this.now();
    const rule: RiskRuleRecord = {
      id: this.makeId('rul'),
      tenantId: this.tenantId,
      kind: 'keyword',
      name,
      keywords,
      riskLevel,
      action,
      enabled: input.enabled ?? true,
      builtin: false,
      hitCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.rules.set(rule.id, rule);
    this.persistRule(rule);
    this.audit('staff', 'risk_rule.create', rule.id, 'ok');
    this.emit('risk_rule.created', { ruleId: rule.id, name: rule.name, action: rule.action });
    return rule;
  }

  update(id: string, patch: RiskRuleUpdateInput, actor: 'staff' | 'agent' = 'staff'): RiskRuleRecord {
    const existing = this.require(id);
    if (existing.builtin) throw new GuardError('IMMUTABLE_RESOURCE', '内置红线不可修改');
    const updated: RiskRuleRecord = {
      ...existing,
      name: patch.name === undefined ? existing.name : assertName(patch.name),
      keywords: patch.keywords === undefined ? existing.keywords : assertKeywords(patch.keywords),
      riskLevel:
        patch.riskLevel === undefined ? existing.riskLevel : assertRiskLevel(patch.riskLevel),
      action: patch.action === undefined ? existing.action : assertAction(patch.action),
      enabled: patch.enabled === undefined ? existing.enabled : Boolean(patch.enabled),
      updatedAt: this.now(),
    };
    this.rules.set(id, updated);
    this.persistRule(updated);
    this.audit(actor, 'risk_rule.update', id, 'ok');
    this.emit('risk_rule.updated', { ruleId: id, name: updated.name, enabled: updated.enabled });
    return updated;
  }

  remove(id: string, actor: 'staff' | 'agent' = 'staff'): void {
    const existing = this.require(id);
    if (existing.builtin) throw new GuardError('IMMUTABLE_RESOURCE', '内置红线不可删除');
    this.rules.delete(id);
    this.chain = this.chain
      .then(() => this.backend.deleteRule(id))
      .catch((error: unknown) => this.reportPersist(error));
    this.audit(actor, 'risk_rule.delete', id, 'ok');
    this.emit('risk_rule.deleted', { ruleId: id, name: existing.name });
  }

  // ---------- 草稿后校验 ----------

  /** 同步评估草稿；命中时累加 hitCount，并异步落盘。 */
  review(input: DraftReviewInput): DraftReviewResult {
    const hits: RiskRuleRecord[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      const matchesBody = rule.keywords.some((keyword) => input.body.includes(keyword));
      const matchesInbound =
        (rule.action === 'guide' || rule.action === 'escalate') &&
        typeof input.inboundText === 'string' &&
        rule.keywords.some((keyword) => input.inboundText!.includes(keyword));
      if (matchesBody || matchesInbound) hits.push(rule);
    }

    let riskLevel = input.riskLevel;
    for (const rule of hits) {
      riskLevel = maxRisk(riskLevel, rule.riskLevel);
      const updated: RiskRuleRecord = {
        ...rule,
        hitCount: rule.hitCount + 1,
        updatedAt: this.now(),
      };
      this.rules.set(rule.id, updated);
      this.persistRule(updated);
      this.audit('system', 'risk_rule.hit', rule.id, 'ok');
      this.emit('risk_rule.hit', {
        ruleId: rule.id,
        ruleName: rule.name,
        patientId: input.patientId,
        riskLevel: updated.riskLevel,
        action: updated.action,
      });
    }

    const actions = hits.map((rule) => rule.action);
    const escalate = actions.includes('escalate');
    const guideOnly = escalate || actions.includes('guide');
    const hitNames = hits.map((rule) => rule.name);
    const hitIds = hits.map((rule) => rule.id);

    let alert: GuardAlertRecord | undefined;
    if (hits.length > 0 && (escalate || riskLevel === 'high')) {
      alert = this.createAlert({
        kind: escalate ? 'escalate' : 'redline',
        severity: escalate ? 'critical' : 'warning',
        title: escalate ? '急症关键词命中，草稿已改为就医引导' : '草稿命中高风险规则',
        message: `命中规则：${hitNames.join('、')}；风险等级 ${riskLevel}`,
        patientId: input.patientId,
        groupId: input.groupId,
        sessionId: input.sessionId,
        ruleIds: hitIds,
      });
    }

    return {
      riskLevel,
      hits: hitIds,
      hitNames,
      actions,
      escalate,
      guideOnly,
      referralBody: guideOnly ? REFERRAL_BODY : undefined,
      alertId: alert?.id,
    };
  }

  // ---------- 告警 ----------

  escalate(
    patientId: string,
    reason: EscalateReason,
    sessionId?: string,
    actor: 'agent' | 'staff' = 'agent',
  ): GuardAlertRecord {
    const parsed = assertReason(reason);
    const alert = this.createAlert({
      kind: 'escalate',
      severity: 'critical',
      title: `请求人工介入：${ESCALATE_REASON_LABEL[parsed]}`,
      message: `Agent 通过 escalate_to_human 请求顾问接手（${ESCALATE_REASON_LABEL[parsed]}）`,
      patientId,
      sessionId,
      ruleIds: [],
      actor,
    });
    return alert;
  }

  alerts(patientId?: string): GuardAlertRecord[] {
    return this.alertLog
      .filter((alert) => (patientId ? alert.patientId === patientId : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 草稿入队后回填 draftId，方便告警列表直接跳到草稿 */
  linkDraft(alertId: string, draftId: string): void {
    const alert = this.alertLog.find((item) => item.id === alertId);
    if (!alert || alert.draftId === draftId) return;
    alert.draftId = draftId;
    alert.updatedAt = this.now();
    this.persistAlert(alert);
    this.audit('system', 'alert.link_draft', alertId, 'ok');
  }

  audits(): AuditEvent[] {
    return [...this.auditLog];
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  // ---------- 内部 ----------

  private require(id: string): RiskRuleRecord {
    const rule = this.rules.get(id);
    if (!rule) throw new GuardError('NOT_FOUND', `规则 ${id} 不存在`);
    return rule;
  }

  private createAlert(input: {
    kind: 'redline' | 'escalate';
    severity: 'warning' | 'critical';
    title: string;
    message: string;
    patientId?: string;
    groupId?: string;
    sessionId?: string;
    ruleIds: string[];
    actor?: 'agent' | 'staff' | 'system';
  }): GuardAlertRecord {
    const at = this.now();
    const alert: GuardAlertRecord = {
      id: this.makeId('alt'),
      tenantId: this.tenantId,
      kind: input.kind,
      severity: input.severity,
      status: 'open',
      title: input.title,
      message: input.message,
      patientId: input.patientId,
      groupId: input.groupId,
      sessionId: input.sessionId,
      ruleIds: [...input.ruleIds],
      createdAt: at,
      updatedAt: at,
      sandbox: this.sandbox,
    };
    this.alertLog.push(alert);
    this.persistAlert(alert);
    this.audit(input.actor ?? 'system', 'alert.create', alert.id, 'ok', alert.kind);
    this.emit('alert.created', {
      alertId: alert.id,
      kind: alert.kind,
      severity: alert.severity,
      patientId: alert.patientId,
      ruleIds: alert.ruleIds,
    });
    return alert;
  }

  private persistAlert(alert: GuardAlertRecord): void {
    this.chain = this.chain
      .then(() => this.backend.putAlert(alert))
      .catch((error: unknown) => this.reportPersist(error));
  }

  private persistRule(rule: RiskRuleRecord): void {
    this.chain = this.chain
      .then(() => this.backend.putRule(rule))
      .catch((error: unknown) => this.reportPersist(error));
  }

  private reportPersist(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.onPersistError?.(wrapped);
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
}
