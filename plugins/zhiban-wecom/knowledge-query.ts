/**
 * #162 顾问 1:1 问答：知识检索与草稿判定解释。
 *
 * 与话术查询（`话术 …`）分开命中，互不影响：
 * - `知识 <关键词>` / `知识 <编号>`：检索 `zhibanKnowledge`，只引用既有条目；
 * - `为什么高风险` / `解释草稿`：解释该顾问最近一次收到的草稿；
 * - `帮助`：可用指令简表。
 *
 * 只回复发问的员工本人，不向客户群发送（F1）。
 * 回答只引用知识库与规则库中的既有内容，不生成新的医疗建议。
 * 日志只记 userid 尾号、指令类型、命中条数，不记正文。
 */

export interface QueryableKnowledge {
  id: string;
  category: string;
  title: string;
  content: string;
  enabled?: boolean;
  deletedAt?: number;
}

export interface KnowledgeQuerySource {
  list(query?: { q?: string; enabled?: boolean }): QueryableKnowledge[];
}

export interface ExplainableDraft {
  id: string;
  riskLevel: 'low' | 'medium' | 'high';
  ruleNames?: string[];
  /** 是否命中规则；旧草稿可能没有记录 */
  hasRuleEvidence?: boolean;
}

export interface KnowledgeQueryDeps {
  source: () => KnowledgeQuerySource | undefined;
  /** 只返回发问顾问本人的最近草稿 */
  latestDraft: (userId: string) => ExplainableDraft | undefined;
  now?: () => number;
  /** 单顾问每分钟上限，默认 20 */
  rateLimitPerMinute?: number;
}

const RESULT_LIMIT = 3;
const SESSION_TTL_MS = 30 * 60_000;
const SESSION_MAX = 2000;

const KNOWLEDGE_COMMAND = /^知识(?:库)?/;
const EXPLAIN_COMMAND = /^(为什么高风险|为什么标红|解释草稿)\s*$/;
const HELP_COMMAND = /^(帮助|指令|能做什么)\s*$/;

export function isKnowledgeCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    KNOWLEDGE_COMMAND.test(trimmed) || EXPLAIN_COMMAND.test(trimmed) || HELP_COMMAND.test(trimmed)
  );
}

interface Session {
  ids: string[];
  at: number;
}

function normalizeKeyword(text: string): string {
  return text
    .trim()
    .replace(KNOWLEDGE_COMMAND, '')
    .replace(/^[\s:：,，、]+/, '')
    .trim();
}

interface ParsedQuery {
  keyword: string;
  index?: number;
}

function parseQuery(text: string): ParsedQuery {
  const rest = normalizeKeyword(text);
  if (rest === '') return { keyword: '' };
  if (/^\d{1,3}$/.test(rest)) return { keyword: '', index: Number(rest) };
  const withIndex = /^(.*\S)[\s:：,，、]+(\d{1,3})$/.exec(rest);
  if (withIndex) return { keyword: withIndex[1]!.trim(), index: Number(withIndex[2]) };
  return { keyword: rest };
}

function rank(record: QueryableKnowledge, query: string): number {
  const lowered = query.toLowerCase();
  if (record.title.toLowerCase().includes(lowered)) return 3;
  if (record.category.toLowerCase().includes(lowered)) return 2;
  if (record.content.toLowerCase().includes(lowered)) return 1;
  return 0;
}

function isUsable(record: QueryableKnowledge): boolean {
  return record.enabled !== false && record.deletedAt === undefined;
}

function search(records: QueryableKnowledge[], query: string): QueryableKnowledge[] {
  const lowered = query.toLowerCase();
  return records
    .filter((record) => rank(record, lowered) > 0)
    .sort((a, b) => rank(b, lowered) - rank(a, lowered));
}

function summary(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 40)}…`;
}

function riskLabel(level: ExplainableDraft['riskLevel']): string {
  return level === 'high' ? '高风险' : level === 'medium' ? '中风险' : '低风险';
}

export class KnowledgeQueryService {
  private readonly deps: KnowledgeQueryDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly buckets = new Map<string, { at: number; count: number }>();

  constructor(deps: KnowledgeQueryDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 是问答指令时返回回复文本；不是指令返回 undefined，交给改稿流程 */
  reply(userId: string, text: string): string | undefined {
    const trimmed = text.trim();
    const command = HELP_COMMAND.test(trimmed)
      ? 'help'
      : EXPLAIN_COMMAND.test(trimmed)
        ? 'explain'
        : KNOWLEDGE_COMMAND.test(trimmed)
          ? 'knowledge'
          : undefined;
    if (!command) return undefined;

    if (this.overLimit(userId)) {
      return '请求太频繁，请稍后再试（每分钟最多 20 条）。';
    }

    if (command === 'help') {
      return (
        '可用指令：\n' +
        '· 话术 关键词 / 话术 1 —— 查机构话术\n' +
        '· 知识 关键词 / 知识 1 —— 查知识库条目\n' +
        '· 为什么高风险 —— 解释你最近一条草稿判定的原因\n' +
        '· 其他文字会作为改稿指令处理（有待处理草稿时）\n\n' +
        '机器人只回复你本人，不会向客户群发送任何内容。'
      );
    }

    if (command === 'explain') return this.explain(userId);
    return this.knowledge(userId, text);
  }

  private overLimit(userId: string): boolean {
    const limit = this.deps.rateLimitPerMinute ?? 20;
    const now = this.now();
    const bucket = this.buckets.get(userId);
    if (!bucket || now - bucket.at >= 60_000) {
      this.buckets.set(userId, { at: now, count: 1 });
      if (this.buckets.size > SESSION_MAX) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      return false;
    }
    bucket.count += 1;
    return bucket.count > limit;
  }

  /** 看过列表后直接发编号（如「1」）取全文；没有进行中的检索时返回 undefined */
  replyToSelection(userId: string, text: string): string | undefined {
    const trimmed = text.trim();
    if (!/^\d{1,3}$/.test(trimmed)) return undefined;
    const session = this.sessions.get(userId);
    if (!session || this.now() - session.at > SESSION_TTL_MS) {
      this.sessions.delete(userId);
      return undefined;
    }
    const id = session.ids[Number(trimmed) - 1];
    if (!id) return `上次检索结果里没有第 ${trimmed} 条。发「知识 关键词」重新检索。`;
    const record = this.deps
      .source()
      ?.list({ enabled: true })
      .filter(isUsable)
      .find((item) => item.id === id);
    return record ? this.detail(record) : '这条知识已经被删除或停用，请重新检索。';
  }

  private knowledge(userId: string, text: string): string {
    const api = this.deps.source();
    if (!api) return '知识库还没接入，请联系管理员。';
    const records = api.list({ enabled: true }).filter(isUsable);
    if (records.length === 0) return '知识库还没有内容，请联系管理员添加。';

    const { keyword, index } = parseQuery(text);
    // 「知识 条目编号」直接查全文（编号来自上方「来源：知识库条目 …」）
    const exact = keyword === '' ? undefined : records.find((record) => record.id === keyword);
    if (exact) return this.detail(exact);
    if (keyword === '') {
      if (index === undefined) {
        const categories = [...new Set(records.map((record) => record.category))]
          .slice(0, 8)
          .join('、');
        return (
          `知识库共 ${records.length} 条\n分类：${categories}\n\n` +
          '用法：发「知识 关键词」检索，如「知识 饮食」；' +
          '再发「知识 1」查看全文。'
        );
      }
      const picked = this.pick(userId, index - 1);
      if (picked) return this.detail(picked);
      return `上次检索结果里没有第 ${index} 条。发「知识 关键词」重新检索。`;
    }

    const matched = search(records, keyword);
    if (matched.length === 0) {
      return `没有找到与「${keyword}」相关的条目。可在控制台「知识库」补充后再查。`;
    }
    if (index !== undefined) {
      const picked = matched[index - 1];
      if (!picked) return `「${keyword}」只有 ${matched.length} 条，没有第 ${index} 条。`;
      return this.detail(picked);
    }

    const shown = matched.slice(0, RESULT_LIMIT);
    this.sessions.set(userId, { ids: shown.map((record) => record.id), at: this.now() });
    if (this.sessions.size > SESSION_MAX) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const lines = shown.map(
      (record, i) => `${i + 1}. ${record.title}（${record.category}）\n   ${summary(record.content)}`,
    );
    const more =
      matched.length > shown.length ? `\n只显示前 ${shown.length} 条，可以再加一个关键词。` : '';
    return `找到 ${matched.length} 条：\n${lines.join('\n')}${more}\n\n发「知识 1」查看全文。`;
  }

  private pick(userId: string, index: number): QueryableKnowledge | undefined {
    const session = this.sessions.get(userId);
    if (!session || this.now() - session.at > SESSION_TTL_MS) {
      this.sessions.delete(userId);
      return undefined;
    }
    const id = session.ids[index];
    if (!id) return undefined;
    return this.deps
      .source()
      ?.list({ enabled: true })
      .filter(isUsable)
      .find((record) => record.id === id);
  }

  private detail(record: QueryableKnowledge): string {
    return (
      `【${record.title}】${record.category}\n\n` +
      `${record.content}\n\n` +
      `来源：知识库条目 ${record.id}。以上只引用知识库原文，不构成新的医疗建议。`
    );
  }

  private explain(userId: string): string {
    const draft = this.deps.latestDraft(userId);
    if (!draft) return '你最近没有待处理的草稿可解释。';
    const rules = draft.ruleNames?.filter((name) => name.trim() !== '') ?? [];
    if (rules.length === 0) {
      return (
        `你最近一条草稿的判定是${riskLabel(draft.riskLevel)}，但没有命中规则记录。\n` +
        '目前只有规则名可查，没有原文证据；如果确认无误，按正常流程发送即可。'
      );
    }
    return (
      `你最近一条草稿被判定为${riskLabel(draft.riskLevel)}。\n` +
      `命中规则：${rules.join('、')}\n` +
      '说明：草稿或客户消息命中了机构设置的风险关键词。\n' +
      '目前只有规则名，没有原文命中片段；请按规则要求调整措辞后再发，拿不准时先问主管。'
    );
  }
}
