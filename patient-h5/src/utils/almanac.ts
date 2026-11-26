/**
 * 今天页顶部的历法信息：公历 + 农历 + 星期（+ 干支年）。
 *
 * 用 Intl 的 Chinese calendar（`zh-CN-u-ca-chinese`）计算，不引入第三方农历库。
 * 浏览器不支持时退化为只显示公历与星期，不编造农历。
 *
 * 注意：这里**不显示节气与黄历宜忌**。节气需要天文历算表，
 * 凭日期硬编码会给错；黄历宜忌属未经审核的内容，首期不做。
 */

export interface Almanac {
  /** 公历，如「11月26日」 */
  solar: string;
  /** 农历，如「十月十八」；不支持时为 null */
  lunar: string | null;
  /** 干支年，如「丙午年」；不支持时为 null */
  ganZhi: string | null;
  /** 星期，如「星期四」 */
  weekday: string;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 农历日：1–30 → 初一…初十 / 十一…十九 / 二十 / 廿一…廿九 / 三十 */
export function chineseDay(day: number): string {
  if (day === 10) return '初十';
  if (day === 20) return '二十';
  if (day === 30) return '三十';
  if (day < 10) return `初${DIGITS[day]}`;
  if (day < 20) return `十${DIGITS[day - 10]}`;
  if (day < 30) return `廿${DIGITS[day - 20]}`;
  return String(day);
}

export function almanacOf(date: Date = new Date()): Almanac {
  const solar = `${date.getMonth() + 1}月${date.getDate()}日`;
  const weekday = `星期${WEEKDAYS[date.getDay()]}`;

  let lunar: string | null = null;
  let ganZhi: string | null = null;
  try {
    const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const parts = formatter.formatToParts(date);
    const pick = (type: string): string | undefined =>
      parts.find((part) => part.type === type)?.value;
    const month = pick('month');
    const day = Number(pick('day'));
    const yearName = pick('yearName');
    if (month && Number.isFinite(day)) {
      lunar = `${month}${chineseDay(day)}`;
    }
    if (yearName) ganZhi = `${yearName}年`;
  } catch {
    // 旧浏览器没有 Chinese calendar：只显示公历
  }

  return { solar, lunar, ganZhi, weekday };
}

/** 顶部眉标文案：公历 · 农历 · 星期；没有农历时退回「公历 · 星期」 */
export function almanacLine(almanac: Almanac): string {
  return almanac.lunar
    ? `${almanac.solar} · 农历${almanac.lunar} · ${almanac.weekday}`
    : `${almanac.solar} · ${almanac.weekday}`;
}
