/**
 * #37 健康红线门禁：规则存储、关键词后校验、风险分级与升级告警。
 *
 * 设计约定：
 * - 内置四条红线（不诊断 / 不调药 / 不承诺疗效 / 急症只引导就医）只读，
 *   全部参与草稿后校验。`flag` 规则校验草稿正文，防止 Agent 自己说出违规内容；
 *   `guide` / `escalate` 规则只看患者输入——草稿里的条件式提醒
 *   （如「如果出现胸痛、呼吸困难请立即就医」）是合规提示，不应触发整段改写。
 * - 命中的风险等级取「模型自评」与「规则等级」的较高者，不阻断推送。
 * - 急症（action=escalate）与只引导就医（action=guide）会改写草稿正文，
 *   只保留就医引导；action=flag 只抬高风险，正文交给顾问审核。
 * - 审计、告警与事件都不带消息正文与草稿正文，只带规则 id、名称和等级。
 * - 员工（顾问 / 客服）在服务群里的发言也走关键词质检（#P1-QC）：
 *   只匹配 action=flag 的规则（急症规则针对患者输入，员工复述症状不算违规）。
 * - 草稿与员工发言共用同一套关键词匹配：关键词前出现否定词时视为合规提醒
 *   （「不要加量」「请勿自行停药」），不计命中。否定允许跨并列连词
 *   （「不要自己停药或减量」里的「减量」同样是提醒），但不跨逗号、句号。
 */
import type { RiskLevel } from '../c2/types.ts';
import type { AuditEvent } from '../c2/types.ts';

export type RuleKind = 'redline' | 'keyword';
export type RuleAction = 'flag' | 'guide' | 'escalate';

/**
 * 告警的判定层级：
 * - `keyword`：只过了关键词初筛，还没经过模型语义复核（草稿后校验目前都在这一层）；
 * - `semantic`：关键词命中后，模型语义复核判定确实违规（员工发言质检）。
 * 控制台据此区分「待人工确认」和「已确认违规」，避免把初筛当成结论。
 */
export type ReviewStage = 'keyword' | 'semantic';

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
  /** 员工发言质检命中时关联的顾问（id 即企微 userid）；草稿校验告警不填 */
  advisorId?: string;
  /** 命中来源：草稿后校验 or 员工发言质检 */
  source?: 'draft' | 'staff';
  /** 员工发言的存档 msgid，仅用于去重与追溯，不含正文 */
  messageId?: string;
  /** 这条告警停在关键词初筛，还是已经过语义复核确认 */
  reviewStage?: ReviewStage;
  /** 实际命中的关键词（已排除否定句里的提醒），控制台按它加底色 */
  hitKeywords?: string[];
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

/** 关键词初筛的结果：只判断命中，不计数、不告警、不落审计。 */
export interface DraftReviewCheck {
  /** 按「尚未语义复核」的口径算出的风险等级 */
  riskLevel: RiskLevel;
  hits: string[];
  hitNames: string[];
  actions: RuleAction[];
  escalate: boolean;
  guideOnly: boolean;
  referralBody?: string;
  /** 命中 flag 规则的部分——只有这些需要交给模型复核 */
  flagHits: string[];
  flagHitNames: string[];
  /** flag 规则实际命中的关键词（已排除否定句里的提醒） */
  flagHitKeywords: string[];
}

export interface DraftReviewOptions {
  /**
   * 语义复核结论：
   * - `ok`：关键词只是合规提醒 → flag 规则不算命中，风险回到模型自评；
   * - `violation`：确实违规 → 告警标 `semantic`；
   * - 不传 / `unknown`：复核不可用 → 按关键词保守处理，告警标 `keyword`。
   * guide / escalate 规则只看患者输入，不受复核结论影响。
   */
  verdict?: 'violation' | 'ok' | 'unknown';
}

export const REFERRAL_BODY =
  '您描述的情况需要尽快由医生处理。请立即拨打 120 或前往最近医院急诊，不要等待线上回复。';

// ---------- 员工发言质检 ----------

export interface StaffMessageReviewInput {
  /** 员工在服务群里的发言原文；截断后写入告警详情供人工复核，日志与审计仍不带正文 */
  text: string;
  /** 发言人的顾问 id（P1 里就是企微 userid）；其他同事可能为空 */
  advisorId?: string;
  /** 发言人显示名；未登记为顾问时为空 */
  advisorName?: string;
  groupId?: string;
  groupName?: string;
  /** 存档 msgid；同一条消息重复扫描时只记一次 */
  messageId?: string;
  /**
   * 告警的判定层级：调用方的语义复核判为违规时传 semantic；
   * 未装复核能力、复核超时或报错时传 keyword（保守告警）。
   */
  reviewStage?: ReviewStage;
}

export interface StaffMessageReviewResult {
  hits: string[];
  hitNames: string[];
  riskLevel: RiskLevel;
  /** 产生告警时的告警 id；未命中为空 */
  alertId?: string;
}

/**
 * 关键词前的否定词（「不要加量」「请勿自行停药」「不建议自己减量」）。
 * 多字否定词按词判断；单字否定词要防误伤——「特别加量」里的「别」、
 * 「未来」里的「未」都不是否定，所以「别 / 未」只认紧邻位置。
 */
const NEGATION_WORDS = [
  '不要',
  '不能',
  '不可',
  '不会',
  '不应',
  '不宜',
  '不必',
  '无需',
  '不用',
  '不需',
  '没有',
  '避免',
  '禁止',
  '严禁',
  '切忌',
  '切勿',
  '请勿',
  '不建议',
  '不推荐',
  '不主张',
  '别',
  '勿',
  '未',
];

/** 否定词说完之后，还能管到几个字之后的关键词 */
const NEGATION_REACH = 4;
/** 向前取多宽找否定词：最长否定词 3 字 + reach 4 字，留点余量 */
const NEGATION_LOOKBACK = 12;
/** 并列连词：一个否定管几个并列动作（「不要自己停药或减量」） */
const COORDINATION_WORDS = ['或者', '以及', '或', '和', '与', '及', '并', '、'];
/** 分句边界：否定不跨句生效（「不用怕，加量到两片」说的还是加量） */
const CLAUSE_BREAKS = new Set(['，', '。', '；', '！', '？', ';', ',', '!', '?', '\n', '\r']);
/** 并列结构最多向前追几步，避免整段话被一句「不要」罩住 */
const MAX_COORDINATION_HOPS = 3;
/** 「别」的前一个字是这些时，它是「特别 / 分别」而不是否定 */
const NOT_NEGATION_BEFORE_BIE = '特分个差类区性级派告离辨惜作';

/**
 * `from` 到 `position` 之间有没有能管到 `position` 的否定词。
 *
 * 多字否定词：说完之后 4 字以内都算命中的否定，所以「不建议自己减药」
 * 里的「不建议」虽然跨出了 4 字窗口，也照样挡得住。
 */
function hasNegation(text: string, from: number, position: number): boolean {
  const segment = text.slice(from, position);
  for (const word of NEGATION_WORDS) {
    const at = segment.lastIndexOf(word);
    if (at < 0) continue;
    const gap = position - (from + at + word.length);
    if (word.length > 1) {
      if (gap <= NEGATION_REACH) return true;
      continue;
    }
    // 「勿」不参与「特别 / 未来」这类组合，出现在同一分句里就是否定（请勿自行停药）
    if (word === '勿') return true;
    // 「别 / 未」只认紧邻，否则「特别加量」「未来」会被当成否定句
    if (gap !== 0) continue;
    const prev = segment[at - 1];
    if (word === '别' && prev !== undefined && NOT_NEGATION_BEFORE_BIE.includes(prev)) continue;
    return true;
  }
  return false;
}

/** 关键词所在分句的起点：否定只看同一分句，不跨逗号 / 句号。 */
function clauseStart(text: string, start: number, index: number): number {
  for (let i = index - 1; i >= start; i -= 1) {
    if (CLAUSE_BREAKS.has(text[i]!)) return i + 1;
  }
  return start;
}

/**
 * 关键词是不是出现在否定句里（合规提醒）。
 *
 * 否定允许沿并列连词往前延伸：「不要自己停药或减量」里「减量」和「停药」
 * 共享同一个「不要」，两个词都算提醒。但否定不跨逗号 / 句号：
 * 「不用怕，加量到两片」的「加量」仍然算命中。
 */
function isNegated(text: string, index: number): boolean {
  let position = index;
  for (let hop = 0; hop <= MAX_COORDINATION_HOPS; hop += 1) {
    const start = Math.max(0, position - NEGATION_LOOKBACK);
    const from = clauseStart(text, start, position);
    if (hasNegation(text, from, position)) return true;
    // 关键词前面紧贴并列连词（「…停药或|减量」）：跨过连词再看前一个动作
    const segment = text.slice(from, position);
    const connector = COORDINATION_WORDS.find((word) => segment.endsWith(word));
    if (!connector) return false;
    const next = position - connector.length;
    if (next <= from) return false;
    position = next;
  }
  return false;
}

/**
 * 关键词「未被否定的」首次出现位置；没有则返回 -1。
 *
 * 草稿后校验与员工发言质检共用：否定句是合规提醒，不该抬高风险或产生告警。
 */
export function keywordHitIndex(text: string, keyword: string): number {
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf(keyword, cursor);
    if (index < 0) return -1;
    if (!isNegated(text, index)) return index;
    cursor = index + keyword.length;
  }
  return -1;
}

/** 文本里是否出现「未被否定的」关键词；导出便于单测与规则预览复用。 */
export function keywordHit(text: string, keyword: string): boolean {
  return keywordHitIndex(text, keyword) >= 0;
}

/** 员工发言的关键词匹配（与草稿共用同一套否定判断）。 */
export function staffKeywordIndex(text: string, keyword: string): number {
  return keywordHitIndex(text, keyword);
}

/** 员工发言里是否出现「未被否定的」关键词；导出便于单测与规则预览复用。 */
export function staffKeywordHit(text: string, keyword: string): boolean {
  return keywordHitIndex(text, keyword) >= 0;
}

/** 摘录窗口：命中词前后各取多少字 */
const EXCERPT_WINDOW = 80;

/**
 * 告警摘录：以命中词为中心截取，而不是固定取开头。
 *
 * 长发言里命中词常出现在后半段，从头截 300 字会让复核者看不到触发的那句话：
 * 告警的目的是让人核对，不是存档全文。
 */
export function excerptAroundHit(
  text: string,
  index: number,
  length: number,
  window = EXCERPT_WINDOW,
): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

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
      // 不只覆盖「停药 / 减药 / 加量 / 换药」这类调整动作，也要覆盖直接推荐用药
      // （「建议口服某某药」「吃两片」）——顾问一句「建议口服一片降糖药」同样是
      // 在替客户做用药决定。关键词只负责不漏，员工发言会再交给语义复核挡误报。
      keywords: [
        '停药',
        '停用',
        '减药',
        '减量',
        '加量',
        '加药',
        '换药',
        '建议口服',
        '建议服用',
        '吃一片',
        '吃两片',
        '加一片',
        '降糖药',
        '降压药',
        '胰岛素',
        '抗生素',
        '消炎药',
        '止痛药',
        '退烧药',
      ],
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

/**
 * 内置规则的正文由代码维护，存储里可能还是旧版本的定义。
 * 只比较会影响匹配的内容字段；命中计数、启用状态、创建时间不参与比较。
 */
function builtinRuleChanged(existing: RiskRuleRecord, latest: RiskRuleRecord): boolean {
  return (
    existing.kind !== latest.kind ||
    existing.name !== latest.name ||
    existing.riskLevel !== latest.riskLevel ||
    existing.action !== latest.action ||
    existing.keywords.length !== latest.keywords.length ||
    existing.keywords.some((keyword, index) => keyword !== latest.keywords[index])
  );
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
  /** 已质检过的员工消息 msgid，防止重启/重复轮询产生重复告警 */
  private readonly staffSeen = new Set<string>();
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

    // 内置规则不可删改，正文口径由代码维护：
    // 缺的补上；已有的把代码里的最新定义同步进存储。
    // 只做「缺就补」的话，升级后新加的关键词永远到不了已有租户，
    // 红线规则会一直停在首次启动时的那一版。
    for (const rule of builtinRules(this.tenantId, this.now())) {
      const existing = this.rules.get(rule.id);
      if (!existing) {
        this.rules.set(rule.id, rule);
        this.persistRule(rule);
        continue;
      }
      if (!builtinRuleChanged(existing, rule)) continue;
      const synced: RiskRuleRecord = {
        ...rule,
        enabled: existing.enabled,
        hitCount: existing.hitCount,
        createdAt: existing.createdAt,
        updatedAt: this.now(),
      };
      this.rules.set(rule.id, synced);
      this.persistRule(synced);
      this.audit('system', 'risk_rule.sync', rule.id, 'ok');
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

  /**
   * 关键词初筛：只判断命中，不计数、不告警、不落审计。
   *
   * 给「关键词初筛 + 语义复核」用：先看有没有可疑词、命中了哪些规则，
   * 再决定要不要交给模型判断；复核判为合规时不留下任何告警痕迹。
   */
  checkDraft(input: DraftReviewInput): DraftReviewCheck {
    const matched = this.matchDraftRules(input);
    const flagMatched = matched.filter((item) => item.rule.action === 'flag');
    let riskLevel = input.riskLevel;
    for (const { rule } of matched) riskLevel = maxRisk(riskLevel, rule.riskLevel);
    const actions = matched.map((item) => item.rule.action);
    const escalate = actions.includes('escalate');
    const guideOnly = escalate || actions.includes('guide');
    return {
      riskLevel,
      hits: matched.map((item) => item.rule.id),
      hitNames: matched.map((item) => item.rule.name),
      actions,
      escalate,
      guideOnly,
      referralBody: guideOnly ? REFERRAL_BODY : undefined,
      flagHits: flagMatched.map((item) => item.rule.id),
      flagHitNames: flagMatched.map((item) => item.rule.name),
      flagHitKeywords: [...new Set(flagMatched.flatMap((item) => item.keywords))],
    };
  }

  /**
   * 落草稿的判定结果：累加命中、写审计、按需告警。
   *
   * `options.verdict` 是语义复核结论：判为合规时丢掉 flag 规则命中（合规提醒），
   * 没复核或复核不可用时按关键词保守处理。
   */
  review(input: DraftReviewInput, options: DraftReviewOptions = {}): DraftReviewResult {
    const verdict = options.verdict ?? 'unknown';
    const matched = this.matchDraftRules(input);
    // 语义复核只管草稿正文（flag）；急症 / 就医引导看的是患者自己说的话，复核不覆盖
    const dropped =
      verdict === 'ok'
        ? new Set(
            matched.filter((item) => item.rule.action === 'flag').map((item) => item.rule.id),
          )
        : new Set<string>();
    const kept = matched.filter((item) => !dropped.has(item.rule.id));

    let riskLevel = input.riskLevel;
    for (const { rule } of kept) {
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

    const actions = kept.map((item) => item.rule.action);
    const escalate = actions.includes('escalate');
    const guideOnly = escalate || actions.includes('guide');
    const hitNames = kept.map((item) => item.rule.name);
    const hitIds = kept.map((item) => item.rule.id);
    const flagKept = kept.filter((item) => item.rule.action === 'flag');

    let alert: GuardAlertRecord | undefined;
    if (hitIds.length > 0 && (escalate || riskLevel === 'high')) {
      // 管理员要一眼看到「草稿里哪句话踩了线」，而不是只有规则名；
      // 只有急症 / 就医引导这类看患者输入的规则才没有草稿摘录。
      const bodyHits = flagKept.flatMap((item) =>
        item.keywords.map((keyword) => ({
          keyword,
          index: keywordHitIndex(input.body, keyword),
        })),
      );
      const bodyHit = bodyHits.reduce<(typeof bodyHits)[number] | undefined>(
        (first, hit) => (first === undefined || hit.index < first.index ? hit : first),
        undefined,
      );
      const bodyKeywords = [...new Set(bodyHits.map((hit) => hit.keyword))];
      const bodyExcerpt = bodyHit
        ? excerptAroundHit(input.body, bodyHit.index, bodyHit.keyword.length)
        : undefined;
      alert = this.createAlert({
        kind: escalate ? 'escalate' : 'redline',
        severity: escalate ? 'critical' : 'warning',
        title: escalate ? '急症关键词命中，草稿已改为就医引导' : '草稿命中高风险规则',
        message:
          `命中规则：${hitNames.join('、')}；风险等级 ${riskLevel}` +
          (bodyExcerpt ? `。草稿内容：「${bodyExcerpt}」` : ''),
        patientId: input.patientId,
        groupId: input.groupId,
        sessionId: input.sessionId,
        source: 'draft',
        // 草稿红线：模型复核确认违规标 semantic，只过初筛 / 复核不可用标 keyword。
        // 急症升级来自患者输入，不属于「草稿内容判定」，不标层级。
        ...(escalate
          ? {}
          : { reviewStage: verdict === 'violation' && flagKept.length > 0 ? 'semantic' : 'keyword' }),
        ...(bodyKeywords.length > 0 ? { hitKeywords: bodyKeywords } : {}),
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

  /**
   * 草稿规则匹配：flag 校验草稿正文，guide / escalate 只看患者输入。
   *
   * - flag 与员工发言同一套匹配：否定句（「不要自己停药或减量」）是合规提醒，不算命中；
   * - guide / escalate 只看患者输入，确保模型没复述症状也能升级；
   *   草稿正文里的条件式提醒不参与匹配，否则正常关怀草稿会被整段替换成就医引导。
   */
  private matchDraftRules(
    input: DraftReviewInput,
  ): Array<{ rule: RiskRuleRecord; keywords: string[] }> {
    const matched: Array<{ rule: RiskRuleRecord; keywords: string[] }> = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.action === 'flag') {
        const keywords = rule.keywords.filter((keyword) => keywordHit(input.body, keyword));
        if (keywords.length > 0) matched.push({ rule, keywords });
        continue;
      }
      const matchesInbound =
        typeof input.inboundText === 'string' &&
        rule.keywords.some((keyword) => input.inboundText!.includes(keyword));
      if (matchesInbound) matched.push({ rule, keywords: [] });
    }
    return matched;
  }

  // ---------- 员工发言质检 ----------

  /**
   * 关键词初筛：只判断命中，不写告警、不计数、不落审计。
   *
   * 给「关键词初筛 + 语义复核」用：先看有没有可疑词，再决定要不要交给模型判断。
   * 这样复核为不违规时，不会留下任何告警痕迹。
   */
  checkStaffMessage(input: StaffMessageReviewInput): StaffMessageReviewResult {
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.trim() === '') return { hits: [], hitNames: [], riskLevel: 'low' };
    const { hits } = this.matchStaffRules(text);
    let riskLevel: RiskLevel = 'low';
    for (const rule of hits) riskLevel = maxRisk(riskLevel, rule.riskLevel);
    return {
      hits: hits.map((rule) => rule.id),
      hitNames: hits.map((rule) => rule.name),
      riskLevel,
    };
  }

  /** 按 action=flag 的规则做关键词匹配，并记下最早命中位置与命中词（供告警摘录与高亮） */
  private matchStaffRules(text: string): {
    hits: RiskRuleRecord[];
    hitIndex: number;
    hitLength: number;
    hitKeywords: string[];
  } {
    const hits: RiskRuleRecord[] = [];
    const hitKeywords: string[] = [];
    let hitIndex = -1;
    let hitLength = 0;
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.action !== 'flag') continue;
      let ruleHit = false;
      for (const keyword of rule.keywords) {
        const index = staffKeywordIndex(text, keyword);
        if (index < 0) continue;
        ruleHit = true;
        if (!hitKeywords.includes(keyword)) hitKeywords.push(keyword);
        if (hitIndex < 0 || index < hitIndex) {
          hitIndex = index;
          hitLength = keyword.length;
        }
      }
      if (ruleHit) hits.push(rule);
    }
    return { hits, hitIndex, hitLength, hitKeywords };
  }

  /**
   * 员工（顾问 / 客服）在服务群里的发言质检。
   *
   * 与草稿校验的区别：
   * - 只看 action=flag 的规则：急症规则是「患者说症状 → 引导就医」，
   *   员工复述症状属于正常沟通，不该被判违规；
   * - 「不要加量 / 请勿停药」这类否定句不算命中；
   * - 命中一律产生 kind=redline、severity=warning 的告警，并带上 advisorId，
   *   供管理后台在顾问个人维度留痕；告警与审计都不含发言正文。
   */
  reviewStaffMessage(input: StaffMessageReviewInput): StaffMessageReviewResult {
    const text = typeof input.text === 'string' ? input.text : '';
    const empty: StaffMessageReviewResult = { hits: [], hitNames: [], riskLevel: 'low' };
    if (text.trim() === '') return empty;
    if (input.messageId) {
      if (this.staffSeen.has(input.messageId)) return empty;
      this.staffSeen.add(input.messageId);
      // 只保留最近 2000 条，避免长时间运行内存无限增长
      if (this.staffSeen.size > 2000) {
        const oldest = this.staffSeen.values().next().value;
        if (oldest !== undefined) this.staffSeen.delete(oldest);
      }
    }

    // 命中位置用于告警摘录：围绕最早出现的关键词截取，不能只截开头
    const { hits, hitIndex, hitLength, hitKeywords } = this.matchStaffRules(text);
    if (hits.length === 0) return empty;

    let riskLevel: RiskLevel = 'low';
    for (const rule of hits) {
      riskLevel = maxRisk(riskLevel, rule.riskLevel);
      const updated: RiskRuleRecord = {
        ...rule,
        hitCount: rule.hitCount + 1,
        updatedAt: this.now(),
      };
      this.rules.set(rule.id, updated);
      this.persistRule(updated);
      this.audit('staff', 'risk_rule.hit', rule.id, 'ok', 'staff_message');
      this.emit('risk_rule.hit', {
        ruleId: rule.id,
        ruleName: rule.name,
        advisorId: input.advisorId,
        groupId: input.groupId,
        source: 'staff',
        riskLevel: updated.riskLevel,
        action: updated.action,
      });
    }

    const hitNames = hits.map((rule) => rule.name);
    const senderName =
      typeof input.advisorName === 'string' && input.advisorName.trim() !== ''
        ? input.advisorName.trim()
        : '员工';
    // 告警详情给人工复核看：带上发言人，原文摘录围绕命中词截取。
    // 日志、审计与 risk_rule.hit 事件仍然不带正文。
    const excerpt =
      hitIndex >= 0
        ? excerptAroundHit(text, hitIndex, hitLength)
        : text.trim().replace(/\s+/g, ' ').slice(0, 300);
    const alert = this.createAlert({
      kind: 'redline',
      severity: 'warning',
      title: '员工发言命中红线',
      message:
        `群「${input.groupName ?? input.groupId ?? '未知群'}」${senderName}的发言命中规则：` +
        `${hitNames.join('、')}。发言内容：「${excerpt}」`,
      advisorId: input.advisorId,
      groupId: input.groupId,
      messageId: input.messageId,
      source: 'staff',
      reviewStage: input.reviewStage ?? 'keyword',
      ...(hitKeywords.length > 0 ? { hitKeywords } : {}),
      ruleIds: hits.map((rule) => rule.id),
      actor: 'staff',
    });

    return {
      hits: hits.map((rule) => rule.id),
      hitNames,
      riskLevel,
      alertId: alert.id,
    };
  }

  /**
   * 语义复核判定为不违规时留痕：不产生告警，只记审计与事件。
   *
   * 关键词仍然命中，但告警会打扰顾问；留下 dismiss 记录，规则调优时能看到误报率。
   * 与告警一样，审计和事件都不带发言正文。
   */
  dismissStaffMessage(input: {
    ruleIds: string[];
    advisorId?: string;
    groupId?: string;
    messageId?: string;
  }): void {
    for (const ruleId of input.ruleIds) {
      this.audit('system', 'risk_rule.dismiss', ruleId, 'ok', 'staff_message');
    }
    this.emit('risk_rule.dismissed', {
      ruleIds: input.ruleIds,
      advisorId: input.advisorId,
      groupId: input.groupId,
      source: 'staff',
    });
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

  /**
   * 草稿入队后回填 draftId，方便告警列表直接跳到草稿。
   *
   * 告警是在草稿落库前产生的，`alert.created` 里还没有 draftId；只写回 guard
   * 存储不够——控制台已经按没有 draftId 的版本入库了。所以回填后必须再发一次
   * `alert.updated`，控制台据此把草稿关联补上，否则告警会变成谁也看不见的孤儿。
   */
  linkDraft(alertId: string, draftId: string): void {
    const alert = this.alertLog.find((item) => item.id === alertId);
    if (!alert) return;
    if (alert.draftId !== draftId) {
      alert.draftId = draftId;
      alert.updatedAt = this.now();
      this.persistAlert(alert);
      this.audit('system', 'alert.link_draft', alertId, 'ok');
    }
    this.emit('alert.updated', this.alertEvent(alert));
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
    advisorId?: string;
    source?: 'draft' | 'staff';
    messageId?: string;
    reviewStage?: ReviewStage;
    hitKeywords?: string[];
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
      ...(input.advisorId ? { advisorId: input.advisorId } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.reviewStage ? { reviewStage: input.reviewStage } : {}),
      ...(input.hitKeywords && input.hitKeywords.length > 0
        ? { hitKeywords: [...input.hitKeywords] }
        : {}),
      ruleIds: [...input.ruleIds],
      createdAt: at,
      updatedAt: at,
      sandbox: this.sandbox,
    };
    this.alertLog.push(alert);
    this.persistAlert(alert);
    this.audit(input.actor ?? 'system', 'alert.create', alert.id, 'ok', alert.kind);
    // 字段与控制台 AlertService.ingest 对齐：控制台用 id / advisorId / groupId
    // 把告警落到「质检与告警」和顾问个人记录里。
    this.emit('alert.created', this.alertEvent(alert));
    return alert;
  }

  /** alert.created / alert.updated 共用的事件载荷；控制台按这些字段入库和补关联 */
  private alertEvent(alert: GuardAlertRecord): Record<string, unknown> {
    return {
      id: alert.id,
      alertId: alert.id,
      kind: alert.kind,
      severity: alert.severity,
      status: alert.status,
      title: alert.title,
      message: alert.message,
      draftId: alert.draftId,
      patientId: alert.patientId,
      advisorId: alert.advisorId,
      groupId: alert.groupId,
      source: alert.source,
      reviewStage: alert.reviewStage,
      hitKeywords: alert.hitKeywords,
      ruleIds: alert.ruleIds,
      createdAt: alert.createdAt,
      updatedAt: alert.updatedAt,
    };
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
