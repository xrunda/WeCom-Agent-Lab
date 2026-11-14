/**
 * #160 承诺抽取：从顾问自己的发言里找出「答应过客户的事」。
 *
 * 只用确定性规则，不调用模型：
 * - 一句里必须同时出现「明确时间词」和「动作词」，否则不建条目（宁缺勿滥）；
 * - 原话是唯一事实来源，提醒文案直接引用，不改写、不推断隐含承诺；
 * - 时间按东八区落到当天 18:00（或识别到的具体时刻）。
 *
 * 本模块是纯函数：不做 I/O、不读环境变量，便于用虚构夹具直接测试。
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** 中国无夏令时，固定 +08:00 */
const SHANGHAI_OFFSET_MS = 8 * 60 * MINUTE_MS;

const TIME_WORDS =
  '今天|今日|今晚|今早|明天|明日|明早|明晚|后天|大后天|本周|这周|这个星期|下周|下个星期|月底|月末';

/** 动作词：只认明确的「我会去做」类动作，不认「已经做了」 */
const ACTION_PATTERN = /发|给|回访|跟进|安排|查|确认|约|联系|回复|提醒|整理|准备|寄|送|报销|申请/;

/** 第一人称或明确主语；没有主语的「明天发您」也算承诺 */
const SUBJECT_PATTERN = /我|咱|我们|这边|给您|跟你|和他|和她/;

const WEEKDAY_CHAR = '[一二三四五六日天1-7]';

const WEEKDAY_INDEX: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 0,
};

export interface PromiseExtraction {
  /** 到期时刻（毫秒） */
  dueAt: number;
  /** 人类可读的时间短语，如「明天 18:00」 */
  dueLabel: string;
  /** 原话（句子本身，已去首尾空白） */
  excerpt: string;
}

export type PromiseStatus = 'pending' | 'done' | 'dismissed';

/** 领域存储里的一条承诺；原话是唯一事实来源 */
export interface PromiseRecord {
  id: string;
  advisorId: string;
  roomId: string;
  groupName: string;
  customerId?: string;
  /** 有 patient.read 时才填；无权限时只显示群名 */
  customerName?: string;
  excerpt: string;
  dueAt: number;
  dueLabel: string;
  /** 来源存档消息 id，用于幂等 */
  sourceMsgId: string;
  status: PromiseStatus;
  /** 已提醒次数；「稍后提醒」最多 2 次 */
  remindCount: number;
  /** 最近一次提醒时刻 */
  remindedAt?: number;
  snoozedAt?: number;
  closedAt?: number;
  createdAt: number;
}

export interface PromiseStore {
  listPromises(): PromiseRecord[];
  getPromise(id: string): PromiseRecord | undefined;
  savePromise(record: PromiseRecord): void;
}

/** 稳定的短 id：同一 msgid + 句子序号生成同一个承诺，重启/重扫不会重复 */
export function promiseId(msgId: string, index: number): string {
  let hash = 2166136261;
  const seed = `${msgId}#${index}`;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `prom_${(hash >>> 0).toString(36)}`;
}

export interface ExtractOptions {
  /** 默认 120 字；超出截断，避免把整段话存进提醒 */
  maxExcerpt?: number;
}

/** 东八区的当天零点（UTC 毫秒） */
export function shanghaiDayStart(at: number): number {
  return Math.floor((at + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

function shanghaiWeekday(at: number): number {
  return new Date(at + SHANGHAI_OFFSET_MS).getUTCDay();
}

function clockLabel(at: number): string {
  const date = new Date(at + SHANGHAI_OFFSET_MS);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${month}-${dayOfMonth} ${hh}:${mm}`;
}

/** 从时间词推出到期时刻；识别不到返回 undefined */
function resolveDue(text: string, at: number): { dueAt: number; phrase: string } | undefined {
  const base = shanghaiDayStart(at);
  const hour = 18;
  const at18 = (dayOffset: number): number => base + dayOffset * DAY_MS + hour * 60 * MINUTE_MS;

  // 「N 天后」/「一周后」
  const afterDays = /(\d{1,2}|一|两|二|三|四|五|六|七)\s*天[后之]/.exec(text);
  if (afterDays) {
    const raw = afterDays[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 }[raw];
    if (n !== undefined) return { dueAt: at18(n), phrase: `${n} 天后` };
  }

  // 具体日期：5 月 12 日 / 5/12
  const monthDay = /(\d{1,2})\s*[月/]\s*(\d{1,2})\s*[日号]?/.exec(text);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = new Date(at + SHANGHAI_OFFSET_MS).getUTCFullYear();
      let due = Date.UTC(year, month - 1, day, hour) - SHANGHAI_OFFSET_MS;
      if (due < base) due = Date.UTC(year + 1, month - 1, day, hour) - SHANGHAI_OFFSET_MS;
      return { dueAt: due, phrase: `${month} 月 ${day} 日` };
    }
  }

  // 周X / 星期X / 礼拜X
  const weekday = new RegExp(
    `(下周|下个星期|本周|这周|这个星期|周|星期|礼拜)(${WEEKDAY_CHAR})`,
  ).exec(text);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[2]!];
    if (target !== undefined) {
      const today = shanghaiWeekday(at);
      const prefix = weekday[1]!;
      // 周一..周日按 1..7 计算，周日是 7
      const targetIso = target === 0 ? 7 : target;
      const todayIso = today === 0 ? 7 : today;
      let delta: number;
      if (prefix === '下周' || prefix === '下个星期') {
        const toNextMonday = ((8 - todayIso) % 7) || 7;
        delta = toNextMonday + targetIso - 1;
      } else if (prefix === '本周' || prefix === '这周' || prefix === '这个星期') {
        delta = Math.max(0, targetIso - todayIso);
      } else {
        delta = ((targetIso - todayIso + 7) % 7) || 7;
      }
      return { dueAt: at18(delta), phrase: `${prefix}${weekday[2]}` };
    }
  }

  if (/月底|月末/.test(text)) {
    const date = new Date(at + SHANGHAI_OFFSET_MS);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const due = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), lastDay, hour) - SHANGHAI_OFFSET_MS;
    return { dueAt: due, phrase: '月底' };
  }

  const rule = new RegExp(TIME_WORDS).exec(text);
  if (!rule) return undefined;
  const word = rule[0];
  const evening = /晚/.test(text) || word === '今晚' || word === '明晚';
  const dueHour = evening ? 20 : hour;
  const atHour = (dayOffset: number): number => base + dayOffset * DAY_MS + dueHour * 60 * MINUTE_MS;

  switch (word) {
    case '今天':
    case '今日':
    case '今晚':
    case '今早':
      return { dueAt: atHour(0), phrase: word };
    case '明天':
    case '明日':
    case '明早':
    case '明晚':
      return { dueAt: atHour(1), phrase: word };
    case '后天':
      return { dueAt: atHour(2), phrase: word };
    case '大后天':
      return { dueAt: atHour(3), phrase: word };
    case '下周':
    case '下个星期': {
      const today = shanghaiWeekday(at);
      const delta = today === 1 ? 7 : 8 - today;
      return { dueAt: atHour(delta), phrase: word };
    }
    case '本周':
    case '这周':
    case '这个星期': {
      const today = shanghaiWeekday(at);
      const delta = today === 0 ? 0 : 7 - today;
      return { dueAt: atHour(delta), phrase: word };
    }
    default:
      return undefined;
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/[。！!；;\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * 抽取一句话里的承诺；一句话最多一条（同句多个时间词按第一个算）。
 * 返回的是「候选」，调用方负责按 msgid 去重与落库。
 */
export function extractPromises(
  text: string,
  at: number,
  options: ExtractOptions = {},
): PromiseExtraction[] {
  const maxExcerpt = options.maxExcerpt ?? 120;
  const results: PromiseExtraction[] = [];
  for (const sentence of splitSentences(text)) {
    // 问句、否定句不建条目
    if (/[?？]|吗[。！!]?$|不[会再]|没法|不能|来不及/.test(sentence)) continue;
    const due = resolveDue(sentence, at);
    if (!due) continue;
    if (!ACTION_PATTERN.test(sentence)) continue;
    // 「发我 / 告诉我」里的「我」是宾语，请求对方做事，不是顾问的承诺
    const subjectText = sentence.replace(
      /(发|给|告诉|回复|联系|提醒|寄|送|安排|确认)(我|咱)(一下|下|一声)?/g,
      '',
    );
    if (!SUBJECT_PATTERN.test(subjectText)) continue;
    // 过去时：已经做了的事不是承诺
    if (/已经|刚刚|上次|昨天|前天|上周/.test(sentence)) continue;
    if (due.dueAt < at) continue;
    const excerpt =
      sentence.length <= maxExcerpt ? sentence : `${sentence.slice(0, maxExcerpt - 1)}…`;
    results.push({
      dueAt: due.dueAt,
      dueLabel: `${due.phrase} ${clockLabel(due.dueAt)}`,
      excerpt,
    });
  }
  return results;
}

/** 卡片/提醒里的一句话摘要；不带客户原文 */
export function promiseReminderLine(promise: {
  groupName: string;
  dueLabel: string;
  excerpt: string;
}): string {
  return `${promise.groupName} · ${promise.dueLabel} · 你说过：${promise.excerpt}`;
}

/** 东八区「月-日 时:分」，顺延后刷新卡片上的时间 */
export function formatDueAt(at: number): string {
  return clockLabel(at);
}
