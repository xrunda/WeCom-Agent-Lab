/**
 * 农历日：用 Intl 的中文历计算，不引第三方库。
 * 日历格子里只显示「日」，初一显示月名（如「十月」）。
 */
import { chineseDay } from './almanac.ts';

export interface LunarDay {
  /** 月名，如「十月」 */
  month: string | null;
  /** 日，如「十八」 */
  day: string | null;
  /** 格子里的短标签：初一显示月名，其余显示日 */
  label: string | null;
}

const cache = new Map<string, LunarDay>();

export function lunarDayOf(dateKey: string): LunarDay {
  const cached = cache.get(dateKey);
  if (cached) return cached;

  let result: LunarDay = { month: null, day: null, label: null };
  try {
    const date = new Date(`${dateKey}T12:00:00+08:00`);
    const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'long',
      day: 'numeric',
    });
    const parts = formatter.formatToParts(date);
    const month = parts.find((part) => part.type === 'month')?.value ?? null;
    const dayNumber = Number(parts.find((part) => part.type === 'day')?.value);
    const day = Number.isFinite(dayNumber) ? chineseDay(dayNumber) : null;
    const label = month && dayNumber === 1 ? month : day;
    result = { month, day, label };
  } catch {
    // 旧浏览器不支持中文历：不显示农历
  }
  cache.set(dateKey, result);
  return result;
}
