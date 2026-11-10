import * as echarts from 'echarts';

import { FONT_FAMILY, chartColors, consoleTokens as t } from './tokens.ts';

/**
 * ECharts 共享主题。所有图表通过 EChart 组件自动套用，
 * 页面里只声明数据与少量语义色，不再逐页写死坐标轴颜色。
 */
echarts.registerTheme('zhiban', {
  color: [t.brand, t.accent, t.warning, t.danger],
  backgroundColor: 'transparent',
  textStyle: {
    fontFamily: FONT_FAMILY,
    color: t.ink2,
    fontSize: 12,
  },
  title: {
    textStyle: { color: t.ink, fontWeight: 600 },
    subtextStyle: { color: t.muted, fontSize: 11 },
  },
  legend: {
    textStyle: { color: t.muted, fontSize: 11 },
    itemWidth: 8,
    itemHeight: 8,
    icon: 'roundRect',
  },
  tooltip: {
    backgroundColor: t.surface,
    borderColor: t.line,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.ink2, fontSize: 12 },
    extraCssText: 'box-shadow: 0 6px 20px rgba(16, 42, 50, 0.10); border-radius: 8px;',
    axisPointer: {
      lineStyle: { color: t.lineStrong },
      crossStyle: { color: t.lineStrong },
      shadowStyle: { color: 'rgba(15, 118, 110, 0.05)' },
    },
  },
  categoryAxis: {
    axisLine: { lineStyle: { color: chartColors.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted2, fontSize: 11 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.muted2, fontSize: 11 },
    splitLine: { lineStyle: { color: chartColors.grid } },
  },
  line: {
    symbol: 'circle',
    symbolSize: 5,
    lineStyle: { width: 2 },
    itemStyle: { borderColor: t.surface, borderWidth: 1.5 },
  },
  bar: {
    barMaxWidth: 18,
    itemStyle: { borderRadius: [3, 3, 0, 0] },
  },
  pie: {
    itemStyle: { borderColor: t.surface, borderWidth: 2 },
  },
});
