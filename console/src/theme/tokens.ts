/**
 * 知伴控制台设计 token（JS 侧）。
 *
 * 与 styles.css 里的 CSS 变量一一对应：CSS 管布局与常规样式，
 * 这里的常量给 ECharts 等拿不到 CSS 变量的地方用。
 */

export const consoleTokens = {
  ink: '#102a32',
  ink2: '#33484f',
  muted: '#5f7076',
  muted2: '#64757b',
  line: '#e3e9e7',
  lineStrong: '#cfd9d5',
  canvas: '#f4f7f6',
  surface: '#ffffff',
  surface2: '#fafcfb',
  brand: '#0f766e',
  brandDeep: '#0b5b55',
  brandTint: '#e9f2f0',
  accent: '#2e9bae',
  positive: '#2f7d46',
  warning: '#b45309',
  danger: '#b42318',
} as const;

export const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

/** 图表专用色：柱体用浅一档的品牌青，线与语义色保持高对比。 */
export const chartColors = {
  volumeBar: '#bfe3dd',
  volumeBarHover: '#a8d8d1',
  grid: '#edf1ef',
  axis: '#e3e9e7',
} as const;

/** 核验结果的业务语义色。未知结局回退到灰色，避免未定义键导致图表报错。 */
export const outcomeColors: Record<string, string> = {
  verified: consoleTokens.brand,
  edit_sent: consoleTokens.accent,
  misroute: consoleTokens.danger,
  unverified: consoleTokens.warning,
};

export function outcomeColor(key: string): string {
  return outcomeColors[key] ?? consoleTokens.muted2;
}
