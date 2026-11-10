import type { EChartsOption } from 'echarts';
import ReactECharts from 'echarts-for-react';

import '../theme/echarts-theme.ts';

/**
 * ECharts 薄封装：统一高度、主题与无障碍标签。
 * 测试环境通过 vitest mock 替换，避免 jsdom 没有 canvas。
 */
export function EChart({
  option,
  height = 280,
  ariaLabel,
}: {
  option: EChartsOption;
  height?: number;
  ariaLabel: string;
}) {
  return (
    <div className="zb-chart" style={{ height }} role="img" aria-label={ariaLabel}>
      <ReactECharts
        option={option}
        theme="zhiban"
        notMerge
        style={{ height: '100%', width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}
