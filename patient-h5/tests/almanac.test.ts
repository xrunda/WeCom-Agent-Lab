/**
 * 农历与页头眉标：用 Intl 中文历，不编造；不支持的浏览器退回公历。
 */
import { describe, expect, it, vi } from 'vitest';

import { almanacLine, almanacOf, chineseDay } from '../src/utils/almanac.ts';

describe('almanac', () => {
  it('农历日的中文写法', () => {
    expect(chineseDay(1)).toBe('初一');
    expect(chineseDay(10)).toBe('初十');
    expect(chineseDay(15)).toBe('十五');
    expect(chineseDay(20)).toBe('二十');
    expect(chineseDay(18)).toBe('十八');
    expect(chineseDay(23)).toBe('廿三');
    expect(chineseDay(30)).toBe('三十');
  });

  it('给出公历、农历、干支年与星期', () => {
    const almanac = almanacOf(new Date('2026-11-26T09:00:00+08:00'));
    expect(almanac.solar).toBe('11月26日');
    expect(almanac.weekday).toBe('星期四');
    // 2026-11-26 为农历丙午年十月十八
    expect(almanac.ganZhi).toBe('丙午年');
    expect(almanac.lunar).toBe('十月十八');
    expect(almanacLine(almanac)).toBe('11月26日 · 农历十月十八 · 星期四');
  });

  it('浏览器不支持中文历时退回公历，不编造农历', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('unsupported');
    });
    const almanac = almanacOf(new Date('2026-11-26T09:00:00+08:00'));
    spy.mockRestore();
    expect(almanac.lunar).toBeNull();
    expect(almanac.ganZhi).toBeNull();
    expect(almanacLine(almanac)).toBe('11月26日 · 星期四');
  });
});
