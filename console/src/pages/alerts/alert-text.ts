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
