import { Alert, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { EChartsOption } from 'echarts';

import { EChart } from '../../components/EChart.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { SampleDataTag } from '../../components/SampleDataTag.tsx';
import { isMockMode } from '../../mock/http.ts';
import {
  SAMPLE_ADVISORS,
  SAMPLE_AVG_RESPONSE_SECONDS,
  SAMPLE_DAYS,
  SAMPLE_OUTCOMES,
  SAMPLE_PASS_RATE,
  SAMPLE_PATIENTS,
  SAMPLE_PERIOD_LABEL,
  SAMPLE_TOTALS,
  type SampleAdvisor,
  type SamplePatient,
} from '../../sample/index.ts';
import { chartColors, consoleTokens as t, outcomeColor } from '../../theme/tokens.ts';
import { formatPercent } from '../../utils/format.ts';
import './reports.css';

const PERIOD_HINT = `${SAMPLE_DAYS[0].label} 至 ${SAMPLE_DAYS[SAMPLE_DAYS.length - 1].label}`;

const monthDayTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatMonthDayTime(ts: number): string {
  return monthDayTimeFormatter.format(new Date(ts)).replace(/\//g, '-');
}

const serviceVolumeOption: EChartsOption = {
  tooltip: { trigger: 'axis' },
  grid: { left: 4, right: 12, top: 14, bottom: 2, containLabel: true },
  xAxis: {
    type: 'category',
    data: SAMPLE_DAYS.map((day) => day.label),
    axisLabel: { interval: 0 },
  },
  yAxis: {
    type: 'value',
    max: 40,
    interval: 10,
  },
  series: [
    {
      name: '服务消息',
      type: 'bar',
      data: SAMPLE_DAYS.map((day) => day.volume),
      barWidth: 12,
      itemStyle: { color: chartColors.volumeBar, borderRadius: [3, 3, 0, 0] },
      emphasis: { itemStyle: { color: chartColors.volumeBarHover } },
      z: 1,
    },
    {
      name: '已核验',
      type: 'line',
      data: SAMPLE_DAYS.map((day) => day.verified),
      smooth: 0.3,
      symbolSize: 5,
      lineStyle: { width: 2, color: t.brand },
      itemStyle: { color: t.brand, borderColor: t.surface, borderWidth: 1.5 },
      z: 3,
    },
  ],
};

const outcomeOption: EChartsOption = {
  tooltip: { trigger: 'item', formatter: '{b}：{c} 条（{d}%）' },
  title: {
    text: formatPercent(SAMPLE_PASS_RATE),
    subtext: '核验通过率',
    left: '32%',
    top: '42%',
    textAlign: 'center',
    textStyle: { fontSize: 25, fontWeight: 600, color: t.ink },
    subtextStyle: { fontSize: 11, color: t.muted },
  },
  legend: {
    orient: 'vertical',
    right: 6,
    top: 'middle',
    icon: 'rect',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 14,
    formatter: (name: string) => {
      const item = SAMPLE_OUTCOMES.find((outcome) => outcome.label === name);
      if (!item) return name;
      return `{name|${name}}{val|${item.count} 条 · ${formatPercent(item.count / SAMPLE_TOTALS.volume)}}`;
    },
    textStyle: {
      rich: {
        name: { width: 50, fontSize: 12, color: t.ink2 },
        val: { fontSize: 12, color: t.muted },
      },
    },
  },
  series: [
    {
      name: '核验结果',
      type: 'pie',
      radius: ['58%', '76%'],
      center: ['32%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
      data: SAMPLE_OUTCOMES.map((item) => ({
        name: item.label,
        value: item.count,
        itemStyle: { color: outcomeColor(item.outcome) },
      })),
    },
  ],
  // 窄面板（<=420px）时环图收小、图例留白，避免图例压在环上。
  media: [
    {
      query: { maxWidth: 420 },
      option: {
        title: { left: '27%' },
        legend: { right: 2 },
        series: [{ center: ['27%', '50%'], radius: ['50%', '66%'] }],
      },
    },
  ],
};

function RateCell({ value }: { value: number }) {
  const percent = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="report-rate">
      <span className="report-rate-bar" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </span>
      <span className="report-num">{formatPercent(value)}</span>
    </span>
  );
}

const advisorColumns: ColumnsType<SampleAdvisor> = [
  {
    title: '顾问',
    dataIndex: 'name',
    key: 'name',
    render: (value: string) => <span className="report-cell-strong">{value}</span>,
  },
  { title: '客户数', dataIndex: 'patientCount', key: 'patientCount', align: 'right', width: 84 },
  { title: '服务消息', dataIndex: 'volume', key: 'volume', align: 'right', width: 92 },
  { title: '已核验', dataIndex: 'verified', key: 'verified', align: 'right', width: 86 },
  { title: '改后发送', dataIndex: 'editSent', key: 'editSent', align: 'right', width: 92 },
  { title: '发错群', dataIndex: 'misroute', key: 'misroute', align: 'right', width: 80 },
  { title: '未核验', dataIndex: 'unverified', key: 'unverified', align: 'right', width: 80 },
  {
    title: '核验通过率',
    key: 'passRate',
    align: 'right',
    width: 128,
    render: (_, advisor) => <RateCell value={advisor.verified / advisor.volume} />,
  },
  {
    title: '平均响应',
    key: 'response',
    align: 'right',
    width: 96,
    render: (_, advisor) => `${advisor.avgResponseSeconds} 秒`,
  },
];

const patientColumns: ColumnsType<SamplePatient> = [
  {
    title: '客户',
    dataIndex: 'name',
    key: 'name',
    render: (value: string) => <span className="report-cell-strong">{value}</span>,
  },
  { title: '顾问', dataIndex: 'advisorName', key: 'advisorName', width: 100 },
  { title: '消息数', dataIndex: 'messages', key: 'messages', align: 'right', width: 88 },
  {
    title: '最近活跃',
    dataIndex: 'lastActiveAt',
    key: 'lastActiveAt',
    width: 128,
    render: (value: number) => <span className="report-cell-muted">{formatMonthDayTime(value)}</span>,
  },
  {
    title: '状态',
    dataIndex: 'activity',
    key: 'activity',
    width: 88,
    render: (value: SamplePatient['activity']) => (
      <span className={['report-state', value === 'active' ? 'is-on' : 'is-off'].join(' ')}>
        <i aria-hidden="true" />
        {value === 'active' ? '活跃' : '沉默'}
      </span>
    ),
  },
];

function ResponseBars() {
  const max = 120;
  const target = SAMPLE_AVG_RESPONSE_SECONDS;
  const advisors = [...SAMPLE_ADVISORS].sort(
    (a, b) => b.avgResponseSeconds - a.avgResponseSeconds,
  );
  const targetLeft = `calc(62px + (100% - 116px) * ${(target / max).toFixed(4)})`;

  return (
    <div className="report-response">
      <div className="report-response-rows">
        <div className="report-response-target" style={{ left: targetLeft }} aria-hidden="true">
          <span>平均 {target} 秒</span>
        </div>
        {advisors.map((advisor) => (
          <div className="report-response-row" key={advisor.id}>
            <span className="report-response-name">{advisor.name}</span>
            <span className="report-response-track">
              <i style={{ width: `${Math.min(100, (advisor.avgResponseSeconds / max) * 100)}%` }} />
            </span>
            <span className="report-response-value report-num">{advisor.avgResponseSeconds} 秒</span>
          </div>
        ))}
      </div>
      <div className="report-response-scale" aria-hidden="true">
        <span />
        <div className="report-response-axis">
          <span>0</span>
          <span>30</span>
          <span>60</span>
          <span>90</span>
          <span>120 秒</span>
        </div>
        <span />
      </div>
      <p className="report-response-summary">
        加权平均 <strong className="report-num">{target} 秒</strong> · {advisors.length} 位顾问 · 目标线为团队加权值
      </p>
    </div>
  );
}

export default function ReportsPage() {
  const patients = [...SAMPLE_PATIENTS].sort((a, b) => b.messages - a.messages);
  const activePatients = SAMPLE_PATIENTS.filter((patient) => patient.activity === 'active').length;

  if (!isMockMode) {
    return (
      <div className="report-page">
        <PageHeader
          title="数据报表"
          description="服务量、响应时效、核验质量、团队对比与客户活跃。"
        />
        <Panel title="尚未接入真实统计">
          <Alert
            type="info"
            showIcon
            message="真实模式下不展示示例报表数字"
            description="数据报表的统计口径尚未接入真实草稿与存档数据，避免与真实运营数据混淆。当前请以工作台 KPI、服务流与审计日志为准。"
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="report-page">
      <PageHeader
        title="数据报表"
        tags={<SampleDataTag />}
        description="服务量、响应时效、核验质量、团队对比与客户活跃。"
      />

      <section className="report-metrics" aria-label="核心指标">
        <div className="report-metric">
          <span className="report-metric-label">服务消息</span>
          <span className="report-metric-value report-num">
            {SAMPLE_TOTALS.volume}
            <small>条</small>
          </span>
          <span className="report-metric-hint">近 14 天 · {PERIOD_HINT}</span>
        </div>
        <div className="report-metric">
          <span className="report-metric-label">已核验</span>
          <span className="report-metric-value report-num">
            {SAMPLE_TOTALS.verified}
            <small>条</small>
          </span>
          <span className="report-metric-hint">
            通过率 <strong className="report-num">{formatPercent(SAMPLE_PASS_RATE)}</strong>
          </span>
        </div>
        <div className="report-metric">
          <span className="report-metric-label">平均响应</span>
          <span className="report-metric-value report-num">
            {SAMPLE_AVG_RESPONSE_SECONDS}
            <small>秒</small>
          </span>
          <span className="report-metric-hint">按服务量加权</span>
        </div>
        <div className="report-metric">
          <span className="report-metric-label">覆盖客户</span>
          <span className="report-metric-value report-num">
            {SAMPLE_TOTALS.patients}
            <small>位</small>
          </span>
          <span className="report-metric-hint">{activePatients} 位近 7 天内有互动</span>
        </div>
      </section>

      <div className="report-grid report-grid-main">
        <Panel
          title="服务量与核验趋势"
          extra={
            <div className="report-legend">
              <span>
                <i style={{ background: chartColors.volumeBar }} />
                服务消息
              </span>
              <span>
                <i className="is-line" style={{ background: t.brand }} />
                已核验
              </span>
            </div>
          }
        >
          <EChart option={serviceVolumeOption} height={262} ariaLabel="近 14 天服务消息与已核验趋势" />
          <p className="report-chart-note">
            近 14 天合计 {SAMPLE_TOTALS.volume} 条服务消息，其中已核验 {SAMPLE_TOTALS.verified} 条。
          </p>
        </Panel>

        <Panel title="核验结果构成" hint={`合计 ${SAMPLE_TOTALS.volume} 条`}>
          <EChart option={outcomeOption} height={286} ariaLabel="核验结果构成环形图" />
        </Panel>
      </div>

      <div className="report-grid report-grid-secondary">
        <Panel title="响应时效" hint="按顾问 · 秒" className="report-response-panel">
          <ResponseBars />
        </Panel>

        <Panel title="口径说明">
          <dl className="report-notes">
            <div>
              <dt>服务消息</dt>
              <dd>顾问收到并进入服务流的客户消息数。</dd>
            </div>
            <div>
              <dt>核验通过率</dt>
              <dd>已核验草稿 ÷ 已发出草稿；改后发送、发错群、未核验计入其余三类。</dd>
            </div>
            <div>
              <dt>平均响应</dt>
              <dd>从客户消息到草稿推送的时长，按顾问服务量加权。</dd>
            </div>
            <div>
              <dt>客户活跃</dt>
              <dd>近 7 天内有消息来往为活跃，否则标为沉默。示例中沉默客户为 3 位。</dd>
            </div>
          </dl>
        </Panel>
      </div>

      <Panel
        title="顾问对比"
        count={`${SAMPLE_ADVISORS.length} 位`}
        hint="按服务量排序"
        flush
        className="report-table-panel"
      >
        <Table<SampleAdvisor>
          rowKey="id"
          size="middle"
          columns={advisorColumns}
          dataSource={SAMPLE_ADVISORS}
          pagination={false}
          scroll={{ x: 960 }}
        />
      </Panel>

      <Panel
        title="客户活跃"
        count={`${SAMPLE_PATIENTS.length} 位`}
        hint="按消息数排序"
        flush
        className="report-table-panel"
      >
        <Table<SamplePatient>
          rowKey="id"
          size="middle"
          columns={patientColumns}
          dataSource={patients}
          pagination={false}
          scroll={{ x: 560 }}
        />
      </Panel>

      <p className="report-sample-note">
        本页为预置示例：{SAMPLE_PERIOD_LABEL}，{SAMPLE_ADVISORS.length} 位顾问、{SAMPLE_TOTALS.patients} 位客户、
        {SAMPLE_TOTALS.volume} 条服务消息。顾问合计与趋势合计一致；核验结果四类合计同样为 {SAMPLE_TOTALS.volume} 条。
      </p>
    </div>
  );
}
