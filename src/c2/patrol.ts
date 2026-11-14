/**
 * #161 主动巡检：沉默流失与情绪投诉信号的纯规则实现。
 *
 * 原则：聚合、去重、不带正文、宁缺勿滥。
 * - 沉默：客户最后发言 ≥ silentDays 天，且顾问同期在该群没有发言；
 * - 投诉：客户消息命中高置信关键词，只记录命中的关键词，不保存原文；
 * - 每日汇总最多 3 条，按严重度排序，无信号不推。
 *
 * 纯函数模块：不做 I/O，便于用虚构夹具测试。
 */

const DAY_MS = 24 * 60 * 60_000;

export type PatrolSignalKind = 'silent' | 'complaint';

export interface PatrolSignal {
  id: string;
  kind: PatrolSignalKind;
  advisorId: string;
  roomId: string;
  groupName: string;
  customerId?: string;
  /** 有 patient.read 时才填；否则只显示群名 */
  customerName?: string;
  /** 沉默天数或信号发生天数 */
  days: number;
  /** 仅投诉信号 */
  keywords?: string[];
  at: number;
}

export interface SilenceInput {
  lastCustomerAt?: number;
  lastAdvisorAt?: number;
  now: number;
  silentDays?: number;
}

export const DEFAULT_SILENT_DAYS = 7;

export function isSilent(input: SilenceInput): boolean {
  if (input.lastCustomerAt === undefined) return false;
  const days = input.silentDays ?? DEFAULT_SILENT_DAYS;
  const since = input.now - days * DAY_MS;
  if (input.lastCustomerAt > since) return false;
  // 顾问近期在群里说过话，说明不是没人管
  if (input.lastAdvisorAt !== undefined && input.lastAdvisorAt > since) return false;
  return true;
}

/**
 * 高置信投诉/风险词。命中词只用于内部信号与告警，不进入任何对外文本。
 * 宁可漏，不可把「过敏」这类正常健康讨论全部当成投诉：
 * 单独的「过敏」不算，必须是「过敏加重/过敏了/过敏反应」等表达。
 */
export const COMPLAINT_KEYWORDS: readonly string[] = [
  '投诉',
  '曝光',
  '律师',
  '药监',
  '退款',
  '退费',
  '举报',
  '差评',
  '态度差',
  '太失望',
  '很不满意',
  '非常不满意',
  '没人管',
  '过敏反应',
  '过敏加重',
  '住院了',
  '急诊',
  '不舒服加重',
  '病情加重',
];

export interface ComplaintHit {
  keywords: string[];
  /** 命中片段，最长 30 字；只用于内部判定与告警，不对外发送 */
  excerpt: string;
}

/** 命中 1 个以上关键词才算投诉信号 */
export function matchComplaints(text: string): ComplaintHit | undefined {
  if (text.trim() === '') return undefined;
  const keywords = COMPLAINT_KEYWORDS.filter((keyword) => text.includes(keyword));
  if (keywords.length === 0) return undefined;
  const first = Math.min(
    ...keywords.map((keyword) => {
      const index = text.indexOf(keyword);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }),
  );
  const start = Math.max(0, first - 6);
  const excerpt = text.slice(start, start + 30).replace(/\s+/g, ' ').trim();
  return { keywords, excerpt };
}

export interface DigestOptions {
  now: number;
  maxItems?: number;
  /** 无权限时忽略 customerName */
  canReadPatient?: boolean;
}

/** 严重度：投诉 > 沉默；同为投诉时命中词多的更靠前，沉默时天数多的更靠前 */
function severity(signal: PatrolSignal): number {
  if (signal.kind === 'complaint') return 100 + (signal.keywords?.length ?? 0);
  return signal.days;
}

export function rankSignals(signals: PatrolSignal[]): PatrolSignal[] {
  return [...signals].sort(
    (a, b) =>
      severity(b) - severity(a) ||
      a.at - b.at ||
      a.id.localeCompare(b.id),
  );
}

/**
 * 生成每日汇总文本；没有信号时返回 undefined（当天不推）。
 * 文本只含「哪个群、什么信号、多久」，不含客户消息正文。
 */
export function buildPatrolDigest(
  signals: PatrolSignal[],
  options: DigestOptions,
): string | undefined {
  if (signals.length === 0) return undefined;
  const maxItems = options.maxItems ?? 3;
  const ranked = rankSignals(signals);
  const shown = ranked.slice(0, maxItems);
  const groups = new Set(shown.map((signal) => signal.roomId)).size;
  const lines = shown.map((signal, index) => {
    const who =
      options.canReadPatient !== false && signal.customerName
        ? `${signal.groupName} · ${signal.customerName}`
        : signal.groupName;
    if (signal.kind === 'complaint') {
      return `${index + 1}. ${who} · 出现投诉/风险信号（今天）`;
    }
    return `${index + 1}. ${who} · 客户已沉默 ${signal.days} 天`;
  });
  const more = ranked.length > shown.length ? `\n另有 ${ranked.length - shown.length} 条，打开侧边栏查看。` : '';
  return `今日巡检 · ${groups} 个群需要关注\n${lines.join('\n')}${more}\n\n回「今天不看」可暂停今天的巡检提醒。`;
}

export interface DedupeEntry {
  kind: PatrolSignalKind;
  roomId: string;
  customerId?: string;
  at: number;
}

export interface DedupeOptions {
  now: number;
  /** 同一客户（无客户 id 时同一群）多少天内不重复 */
  perCustomerDays?: number;
}

/** 同一客户 14 天内只提醒一次；没有客户 id 时按群去重 */
export function isDuplicateSignal(
  signal: Pick<PatrolSignal, 'kind' | 'roomId' | 'customerId'>,
  recent: DedupeEntry[],
  options: DedupeOptions,
): boolean {
  const days = options.perCustomerDays ?? 14;
  const since = options.now - days * DAY_MS;
  return recent.some((entry) => {
    if (entry.at < since) return false;
    if (entry.kind !== signal.kind) return false;
    if (signal.customerId && entry.customerId) {
      return entry.customerId === signal.customerId;
    }
    return entry.roomId === signal.roomId;
  });
}
