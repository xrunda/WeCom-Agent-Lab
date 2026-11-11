/**
 * 顾问在企微 1:1 里查询话术库。
 *
 * 话术库由管理后台维护（`zhiban-console` 的 `zhibanScripts` 只读入口），
 * 顾问不必登录控制台：私聊机器人发「话术 复诊」拿到列表，再发「话术 1」取全文，
 * 自己复制粘贴到客户群。机器人只回复发问的员工本人，不向客户群发送任何消息（F1）。
 *
 * 查询状态（上一次结果的编号）只保存在内存里，30 分钟过期；重启后需重新搜索。
 */
export interface QueryableScript {
  id: string;
  category: string;
  title: string;
  content: string;
  tags?: string[];
}

export interface ScriptQuerySource {
  listEnabled(): QueryableScript[];
}

const RESULT_LIMIT = 8;
const SESSION_TTL_MS = 30 * 60_000;
const SESSION_MAX = 2000;

/** 企微 markdown 单条有字节上限，长话术拆成多条发送 */
export const WECOM_TEXT_MAX_BYTES = 2000;

/**
 * 按 UTF-8 字节切分长文本，优先在换行处断开。
 * `splitForWecom(text).join('') === text`，不丢字符。
 */
export function splitForWecom(text: string, maxBytes = WECOM_TEXT_MAX_BYTES): string[] {
  if (text === '') return [];
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes && current !== '') {
      const breakAt = current.lastIndexOf('\n');
      const cut = breakAt > 0 ? breakAt + 1 : current.length;
      chunks.push(current.slice(0, cut));
      current = current.slice(cut);
      bytes = Buffer.byteLength(current, 'utf8');
    }
    current += char;
    bytes += size;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

interface Session {
  ids: string[];
  at: number;
}

/** 指令前缀：`话术`、`话术查询`，后面可跟关键词或编号 */
const COMMAND = /^话术(?:查询)?/;

export function isScriptQuery(text: string): boolean {
  return COMMAND.test(text.trim());
}

function normalizeKeyword(text: string): string {
  return text.trim().replace(COMMAND, '').replace(/^[\s:：,，、]+/, '').trim();
}

interface ParsedQuery {
  keyword: string;
  /** 1 起的编号；`话术 饮食 1`、`话术 1` 都会解析出编号 */
  index?: number;
}

function parseQuery(text: string): ParsedQuery {
  const rest = normalizeKeyword(text);
  if (rest === '') return { keyword: '' };
  if (/^\d{1,3}$/.test(rest)) return { keyword: '', index: Number(rest) };
  // 关键词 + 编号：`饮食 1`、`饮食：1`。分开写才按编号解析，避免把「维生素B12」当编号
  const withIndex = /^(.*\S)[\s:：,，、]+(\d{1,3})$/.exec(rest);
  if (withIndex) return { keyword: withIndex[1].trim(), index: Number(withIndex[2]) };
  return { keyword: rest };
}

function includesQuery(value: string, query: string): boolean {
  return value.toLowerCase().includes(query);
}

/** 标题命中优先于分类/标签，最后才是正文 */
function rank(script: QueryableScript, query: string): number {
  if (includesQuery(script.title, query)) return 3;
  if (includesQuery(script.category, query)) return 2;
  if ((script.tags ?? []).some((tag) => includesQuery(tag, query))) return 2;
  if (includesQuery(script.content, query)) return 1;
  return 0;
}

/**
 * 关键词正好是分类名时只返回该分类，避免「话术 饮食」把正文提到饮食的话术也带出来；
 * 否则按标题 > 分类/标签 > 正文排序。
 */
function searchScripts(scripts: QueryableScript[], query: string): QueryableScript[] {
  const lowered = query.toLowerCase();
  const exactCategory = scripts.filter(
    (script) => script.category.toLowerCase() === lowered,
  );
  if (exactCategory.length > 0) {
    return [...exactCategory].sort((a, b) => a.title.localeCompare(b.title));
  }
  return scripts
    .filter((script) => rank(script, lowered) > 0)
    .sort((a, b) => rank(b, lowered) - rank(a, lowered) || a.title.localeCompare(b.title));
}

export class ScriptQueryService {
  private readonly sessions = new Map<string, Session>();
  private readonly source: () => ScriptQuerySource | undefined;
  private readonly now: () => number;

  constructor(
    source: () => ScriptQuerySource | undefined,
    now: () => number = () => Date.now(),
  ) {
    this.source = source;
    this.now = now;
  }

  /** 是话术指令时返回回复文本；不是指令返回 undefined，交给改稿流程 */
  reply(userId: string, text: string): string | undefined {
    if (!isScriptQuery(text)) return undefined;

    const api = this.source();
    if (!api) return '话术库还没接入，请联系管理员。';
    const scripts = api.listEnabled();
    if (scripts.length === 0) return '话术库还没有内容，请联系管理员添加。';

    const { keyword, index } = parseQuery(text);
    if (keyword === '') {
      if (index === undefined) return this.overview(scripts);
      // 「话术 1」：取上一次搜索结果的第 N 条
      const picked = this.pick(userId, index - 1);
      if (picked) return this.detail(picked);
      return `上次搜索结果里没有第 ${index} 条。发「话术 关键词」重新搜索，或直接发「话术 饮食 1」。`;
    }

    const matched = searchScripts(scripts, keyword);
    if (matched.length === 0) {
      return `没找到与「${keyword}」匹配的话术。发「话术」可查看分类。`;
    }

    // 「话术 饮食 1」：一次搜索直接取第 N 条，不用先看列表
    if (index !== undefined) {
      const picked = matched[index - 1];
      if (!picked) {
        return `「${keyword}」只有 ${matched.length} 条，没有第 ${index} 条。`;
      }
      return this.detail(picked);
    }

    const shown = matched.slice(0, RESULT_LIMIT);
    this.sessions.set(userId, { ids: shown.map((script) => script.id), at: this.now() });
    if (this.sessions.size > SESSION_MAX) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const lines = shown.map((script, i) => `${i + 1}. ${script.title}（${script.category}）`);
    const more =
      matched.length > shown.length ? `\n只显示前 ${shown.length} 条，可以再加一个关键词。` : '';
    return (
      `找到 ${matched.length} 条话术：\n${lines.join('\n')}${more}\n\n` +
      '回复「话术 1」查看全文，也可以直接发「1」。'
    );
  }

  /**
   * 看过列表后直接发数字（如「1」）取全文。
   * 没有进行中的搜索结果时返回 undefined，交给改稿流程，避免劫持普通对话。
   */
  replyToSelection(userId: string, text: string): string | undefined {
    const trimmed = text.trim();
    if (!/^\d{1,3}$/.test(trimmed)) return undefined;
    const session = this.sessions.get(userId);
    if (!session || this.now() - session.at > SESSION_TTL_MS) {
      this.sessions.delete(userId);
      return undefined;
    }
    const picked = this.pick(userId, Number(trimmed) - 1);
    if (picked) return this.detail(picked);
    return `上次搜索结果里没有第 ${trimmed} 条。可以发「话术 关键词」重新搜索。`;
  }

  private pick(userId: string, index: number): QueryableScript | undefined {
    const session = this.sessions.get(userId);
    if (!session || this.now() - session.at > SESSION_TTL_MS) {
      this.sessions.delete(userId);
      return undefined;
    }
    const id = session.ids[index];
    if (!id) return undefined;
    return this.source()
      ?.listEnabled()
      .find((script) => script.id === id);
  }

  private overview(scripts: QueryableScript[]): string {
    const counts = new Map<string, number>();
    for (const script of scripts) {
      counts.set(script.category, (counts.get(script.category) ?? 0) + 1);
    }
    const categories = [...counts.entries()]
      .map(([category, count]) => `${category} ${count}`)
      .join(' · ');
    return (
      `话术库共 ${scripts.length} 条\n分类：${categories}\n\n` +
      '用法：\n· 发「话术 关键词」搜索，如「话术 复诊」\n' +
      '· 发了分类名就只列该分类，如「话术 饮食」\n' +
      '· 要第几条直接写编号：先发「话术 饮食」，再发「1」；或一步到位「话术 饮食 1」\n\n' +
      '机器人只回复你本人，不会把这些话术发到客户群；复制后自行粘贴发送。'
    );
  }

  private detail(script: QueryableScript): string {
    const tags = script.tags && script.tags.length > 0 ? ` · 标签：${script.tags.join('、')}` : '';
    return (
      `【${script.title}】${script.category}${tags}\n\n` +
      `${script.content}\n\n` +
      '复制后粘贴到客户群发送。机器人不会自动发送。'
    );
  }
}
