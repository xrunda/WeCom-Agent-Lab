/**
 * 节气天文算法：用真实历法日期校验，防止 ±1 天错误。
 */
import { describe, expect, it } from 'vitest';

import { localDateKey, nextSolarTerm, solarTermOn, solarTermsOfYear } from '../src/utils/solar-terms.ts';

describe('二十四节气', () => {
  it('2026 年的关键节气日期与通用历一致', () => {
    const terms = new Map(solarTermsOfYear(2026).map((t) => [t.name, t.date.slice(5)]));
    expect(terms.get('立春')).toBe('02-04');
    expect(terms.get('春分')).toBe('03-20');
    expect(terms.get('夏至')).toBe('06-21');
    expect(terms.get('秋分')).toBe('09-23');
    expect(terms.get('立冬')).toBe('11-07');
    expect(terms.get('小雪')).toBe('11-22');
    expect(terms.get('大雪')).toBe('12-07');
    expect(terms.get('冬至')).toBe('12-22');
  });

  it('一年恰好 24 个节气，且按时间升序', () => {
    const terms = solarTermsOfYear(2026);
    expect(terms).toHaveLength(24);
    for (let i = 1; i < terms.length; i += 1) {
      expect(terms[i]!.at).toBeGreaterThan(terms[i - 1]!.at);
    }
  });

  it('识别某天是否是节气日', () => {
    expect(solarTermOn('2026-11-22')).toBe('小雪');
    expect(solarTermOn('2026-12-07')).toBe('大雪');
    expect(solarTermOn('2026-11-26')).toBeNull();
  });

  it('距下一个节气的天数（当天为 0）', () => {
    expect(nextSolarTerm('2026-11-26')).toEqual({ name: '大雪', date: '2026-12-07', days: 11 });
    expect(nextSolarTerm('2026-12-07')).toEqual({ name: '大雪', date: '2026-12-07', days: 0 });
    // 跨年：12-23 之后是小寒
    expect(nextSolarTerm('2026-12-25').name).toBe('小寒');
  });

  it('节气时刻按 Asia/Shanghai 归日', () => {
    const winter = solarTermsOfYear(2026).find((t) => t.name === '冬至')!;
    expect(localDateKey(winter.at)).toBe('2026-12-22');
  });
});
