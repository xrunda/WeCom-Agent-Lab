/**
 * 二十四节气：按天文算法实时计算，不硬编码日期。
 *
 * 原理：节气发生在太阳视黄经为 15° 整数倍时（春分 0°、清明 15°…冬至 270°）。
 * 用 Meeus《天文算法》低精度公式求太阳视黄经，再对目标黄经二分逼近。
 * 精度约 15 分钟，足以判断「今天是哪个节气 / 距下一个还有几天」。
 *
 * 日期一律按 Asia/Shanghai 计算（与产品其余部分一致）。
 */

const RAD = Math.PI / 180;

interface TermDef {
  name: string;
  /** 太阳视黄经（度） */
  longitude: number;
  /** 平均日期，用于确定二分区间 */
  month: number;
  day: number;
}

/** 按日历顺序排列（小寒 → 冬至），平均日期仅作二分起点 */
const TERMS: readonly TermDef[] = [
  { name: '小寒', longitude: 285, month: 1, day: 6 },
  { name: '大寒', longitude: 300, month: 1, day: 20 },
  { name: '立春', longitude: 315, month: 2, day: 4 },
  { name: '雨水', longitude: 330, month: 2, day: 19 },
  { name: '惊蛰', longitude: 345, month: 3, day: 6 },
  { name: '春分', longitude: 0, month: 3, day: 21 },
  { name: '清明', longitude: 15, month: 4, day: 5 },
  { name: '谷雨', longitude: 30, month: 4, day: 20 },
  { name: '立夏', longitude: 45, month: 5, day: 6 },
  { name: '小满', longitude: 60, month: 5, day: 21 },
  { name: '芒种', longitude: 75, month: 6, day: 6 },
  { name: '夏至', longitude: 90, month: 6, day: 21 },
  { name: '小暑', longitude: 105, month: 7, day: 7 },
  { name: '大暑', longitude: 120, month: 7, day: 23 },
  { name: '立秋', longitude: 135, month: 8, day: 8 },
  { name: '处暑', longitude: 150, month: 8, day: 23 },
  { name: '白露', longitude: 165, month: 9, day: 8 },
  { name: '秋分', longitude: 180, month: 9, day: 23 },
  { name: '寒露', longitude: 195, month: 10, day: 8 },
  { name: '霜降', longitude: 210, month: 10, day: 23 },
  { name: '立冬', longitude: 225, month: 11, day: 7 },
  { name: '小雪', longitude: 240, month: 11, day: 22 },
  { name: '大雪', longitude: 255, month: 12, day: 7 },
  { name: '冬至', longitude: 270, month: 12, day: 22 },
];

export type SolarTermName = string;

/** 儒略日（含小数） */
function julianDay(ms: number): number {
  return ms / 86_400_000 + 2440587.5;
}

/** 太阳视黄经（度，0–360）；Meeus 低精度公式，误差约 0.01° */
export function solarLongitude(ms: number): number {
  const T = (julianDay(ms) - 2451545) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * RAD) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M * RAD) +
    0.000289 * Math.sin(3 * M * RAD);
  const omega = 125.04 - 1934.136 * T;
  const apparent = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  return ((apparent % 360) + 360) % 360;
}

/** 角度差，折算到 (-180, 180]，避免 0/360 处跳变 */
function deltaAngle(current: number, target: number): number {
  let diff = ((current - target) % 360 + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

/** 本地日期键（Asia/Shanghai） */
export function localDateKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(ms));
}

/**
 * 二分求节气时刻：黄经随时间单调递增，
 * 差值为正说明已过目标（时间取早了），故收敛 high。
 */
export function termTime(year: number, def: TermDef): number {
  let low = Date.UTC(year, def.month - 1, def.day) - 8 * 86_400_000;
  let high = Date.UTC(year, def.month - 1, def.day) + 8 * 86_400_000;
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2;
    if (deltaAngle(solarLongitude(mid), def.longitude) > 0) high = mid;
    else low = mid;
  }
  return Math.round((low + high) / 2);
}

export interface SolarTerm {
  name: SolarTermName;
  /** 节气当天（本地日期键） */
  date: string;
  at: number;
}

/** 某年 24 个节气，按时间升序 */
export function solarTermsOfYear(year: number): SolarTerm[] {
  return TERMS.map((def) => {
    const at = termTime(year, def);
    return { name: def.name, at, date: localDateKey(at) };
  }).sort((a, b) => a.at - b.at);
}

/** 某天是否是节气日 */
export function solarTermOn(dateKey: string): SolarTermName | null {
  const year = Number(dateKey.slice(0, 4));
  for (const offset of [0, -1, 1]) {
    const hit = solarTermsOfYear(year + offset).find((term) => term.date === dateKey);
    if (hit) return hit.name;
  }
  return null;
}

export interface NextTerm {
  name: SolarTermName;
  /** 距今天数；节气当天为 0 */
  days: number;
  date: string;
}

/** 今天及之后最近的节气 */
export function nextSolarTerm(todayKey: string): NextTerm {
  const year = Number(todayKey.slice(0, 4));
  const today = Date.parse(`${todayKey}T00:00:00+08:00`);
  const upcoming = [...solarTermsOfYear(year), ...solarTermsOfYear(year + 1)]
    .map((term) => ({
      name: term.name,
      date: term.date,
      days: Math.round((Date.parse(`${term.date}T00:00:00+08:00`) - today) / 86_400_000),
    }))
    .filter((term) => term.days >= 0)
    .sort((a, b) => a.days - b.days);
  return upcoming[0]!;
}
