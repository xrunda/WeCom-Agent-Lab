/**
 * 告警正文的纯文本处理：拆出员工发言原文、按关键词切分高亮。
 *
 * 不 import 任何界面或 mock 模块，方便直接单测。
 */

export interface StaffQuoteParts {
  /** 「发言内容：「」之前，含左引号 */
  before: string;
  /** 引号内的发言原文；没有引文时为 undefined */
  quote?: string;
  /** 右引号及之后 */
  after: string;
}

/**
 * 从告警正文里拆出员工发言原文。
 *
 * 正文形如：群「…」李光的发言命中规则：不诊断。发言内容：「…」。
 * 群名也用「」，所以只认「发言内容：」后面的那一对引号。
 */
export function splitStaffQuote(message: string): StaffQuoteParts {
  const marker = '发言内容：「';
  const start = message.indexOf(marker);
  if (start < 0) return { before: message, after: '' };
  const quoteStart = start + marker.length;
  const quoteEnd = message.lastIndexOf('」');
  if (quoteEnd <= quoteStart) return { before: message, after: '' };
  return {
    before: message.slice(0, quoteStart),
    quote: message.slice(quoteStart, quoteEnd),
    after: message.slice(quoteEnd),
  };
}

export interface HighlightSegment {
  text: string;
  /** 是否是命中关键词的片段 */
  hit: boolean;
}

/** 把一段文字按命中关键词切成片段，供界面加底色高亮；长关键词优先 */
export function splitByKeywords(text: string, keywords: string[]): HighlightSegment[] {
  const words = [...new Set(keywords.map((word) => word.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (text === '' || words.length === 0) return [{ text, hit: false }];

  const lower = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let plain = '';
  let index = 0;
  while (index < text.length) {
    const word = words.find((candidate) => lower.startsWith(candidate.toLowerCase(), index));
    if (!word) {
      plain += text[index];
      index += 1;
      continue;
    }
    if (plain !== '') {
      segments.push({ text: plain, hit: false });
      plain = '';
    }
    const chunk = text.slice(index, index + word.length);
    const last = segments[segments.length - 1];
    if (last?.hit) last.text += chunk;
    else segments.push({ text: chunk, hit: true });
    index += word.length;
  }
  if (plain !== '') segments.push({ text: plain, hit: false });
  return segments;
}

export interface StaffAlertParts {
  /** 发言所在群（正文里自带的群名，接口群名优先） */
  groupName?: string;
  /** 发言人（正文里自带的名称，接口顾问名优先） */
  senderName?: string;
  /** 命中的规则名 */
  rules: string[];
  /** 触发告警的发言原文；拆不出来时退回整条正文 */
  quote: string;
  /** 是否成功拆出引文（告警正文被截断时为 false） */
  hasQuote: boolean;
}

/**
 * 拆解员工发言告警正文：
 * 群「…」NAME的发言命中规则：A、B。发言内容：「…」
 *
 * 正文可能被服务端截断到 500 字，拆不出引文时返回整条正文，
 * 界面仍然按关键词高亮，只是没有「原话」的引号容器。
 */
export function parseStaffAlert(message: string): StaffAlertParts {
  const parts = splitStaffQuote(message);
  const head = /^群「([^」]+)」([\s\S]+?)的发言命中规则：([\s\S]+?)。/.exec(message);
  return {
    groupName: head?.[1]?.trim() || undefined,
    senderName: head?.[2]?.trim() || undefined,
    rules: head?.[3]
      ? head[3]
          .split('、')
          .map((rule) => rule.trim())
          .filter(Boolean)
      : [],
    quote: parts.quote ?? message,
    hasQuote: parts.quote !== undefined,
  };
}

export type DraftRiskLevel = 'low' | 'medium' | 'high';

export interface DraftAlertParts {
  /** 命中规则名，例如「不诊断」「不调药」 */
  rules: string[];
  riskLevel?: DraftRiskLevel;
}

const RISK_LEVEL_LABEL: Record<DraftRiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export function draftRiskLabel(level: DraftRiskLevel | undefined): string | undefined {
  return level ? RISK_LEVEL_LABEL[level] : undefined;
}

/**
 * 拆解草稿红线告警正文：命中规则：A、B；风险等级 high
 *
 * 与员工发言告警不同，草稿告警没有引文，正文本身就是规则与等级的摘要。
 */
export function parseDraftAlert(message: string): DraftAlertParts {
  const rulesMatch = /命中规则：([^；\n]+)/.exec(message);
  const rules = rulesMatch?.[1]
    ? rulesMatch[1]
        .split('、')
        .map((rule) => rule.trim())
        .filter(Boolean)
    : [];
  const levelMatch = /风险等级\s*(low|medium|high)/i.exec(message);
  const level = levelMatch?.[1]?.toLowerCase();
  return {
    rules,
    ...(level === 'low' || level === 'medium' || level === 'high' ? { riskLevel: level } : {}),
  };
}

/** 返回文字里真实出现过的关键词（保留规则里的原始写法，去重） */
export function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return [...new Set(keywords.map((word) => word.trim()).filter(Boolean))].filter((word) =>
    lower.includes(word.toLowerCase()),
  );
}

export interface KeywordRule {
  name: string;
  keywords: string[];
}

/**
 * 命中规则对应的关键词；规则名对不上（改名 / 已删除）时退回全部规则的关键词，
 * 宁可多高亮一个词，也不要让触发告警的那句话没有任何标记。
 */
export function keywordsForRules(ruleNames: string[], rules: KeywordRule[]): string[] {
  const hit = rules.filter((rule) => ruleNames.includes(rule.name));
  const pool = hit.length > 0 ? hit : rules;
  return [...new Set(pool.flatMap((rule) => rule.keywords).map((word) => word.trim()))].filter(
    Boolean,
  );
}
