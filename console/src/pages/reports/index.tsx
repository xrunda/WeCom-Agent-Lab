import { PageContainer } from '@ant-design/pro-components';
import { Card, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { EChartsOption } from 'echarts';

import { EChart } from '../../components/EChart.tsx';
import { SampleDataTag } from '../../components/SampleDataTag.tsx';
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
import { formatDate, formatPercent } from '../../utils/format.ts';
import '../wp-l.css';
import './reports.css';

const { Paragraph, Text } = Typography;

const serviceVolumeOption: EChartsOption = {
  tooltip: { trigger: 'axis' },
  legend: {
    data: ['服务消息', '已核验'],
    top: 0,
    right: 0,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
  },
  grid: { left: 6, right: 10, top: 40, bottom: 2, containLabel: true },
  xAxis: {
    type: 'category',
    data: SAMPLE_DAYS.map((day) => day.label),
    axisTick: { show: false },
    axisLine: { lineStyle: { color: '#e2e8f0' } },
    axisLabel: { color: '#64748b', fontSize: 11 },
  },
  yAxis: {
    type: 'value',
    splitLine: { lineStyle: { color: '#eef2f7' } },
    axisLabel: { color: '#94a3b8', fontSize: 11 },
  },
  series: [
    {
      name: '服务消息',
      type: 'bar',
      data: SAMPLE_DAYS.map((day) => day.volume),
      barWidth: 12,
      itemStyle: { color: '#99f6e4', borderRadius: [4, 4, 0, 0] },
    },
    {
      name: '已核验',
      type: 'line',
      data: SAMPLE_DAYS.map((day) => day.verified),
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 3, color: '#0f766e' },
      itemStyle: { color: '#0f766e' },
    },
  ],
};

const outcomeOption: EChartsOption = {
  tooltip: { trigger: 'item', formatter: '{b}：{c} 条（{d}%）' },
  legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8 },
  title: {
    text: formatPercent(SAMPLE_PASS_RATE),
    subtext: '核验通过率',
    left: 'center',
    top: '36%',
    textStyle: { fontSize: 24, fontWeight: 700, color: '#0f172a' },
    subtextStyle: { fontSize: 12, color: '#64748b' },
  },
  series: [
    {
      name: '核验结果',
      type: 'pie',
      radius: ['58%', '74%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
      label: { show: false },
      data: SAMPLE_OUTCOMES.map((item) => ({
        name: item.label,
        value: item.count,
        itemStyle: { color: item.color },
      })),
    },
  ],
};

const responseOption: EChartsOption = {
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  grid: { left: 6, right: 24, top: 28, bottom: 2, containLabel: true },
  xAxis: {
    type: 'value',
    name: '秒',
    splitLine: { lineStyle: { color: '#eef2f7' } },
    axisLabel: { color: '#94a3b8', fontSize: 11 },
  },
  yAxis: {
    type: 'category',
    data: SAMPLE_ADVISORS.map((advisor) => advisor.name),
    axisTick: { show: false },
    axisLine: { lineStyle: { color: '#e2e8f0' } },
    axisLabel: { color: '#475569', fontSize: 12 },
  },
  series: [
    {
      name: '平均响应',
      type: 'bar',
      barWidth: 16,
      data: SAMPLE_ADVISORS.map((advisor) => advisor.avgResponseSeconds),
      itemStyle: { color: '#0f766e', borderRadius: [0, 6, 6, 0] },
      label: { show: true, position: 'right', color: '#475569', formatter: '{c} 秒' },
      markLine: {
        symbol: 'none',
        lineStyle: { color: '#f59e0b', type: 'dashed' },
        label: { formatter: `平均 ${SAMPLE_AVG_RESPONSE_SECONDS} 秒`, color: '#b45309' },
        data: [{ xAxis: SAMPLE_AVG_RESPONSE_SECONDS }],
      },
    },
  ],
};

const advisorColumns: ColumnsType<SampleAdvisor> = [
  { title: '顾问', dataIndex: 'name', key: 'name', render: (value: string) => <Text strong>{value}</Text> },
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
    width: 104,
    render: (_, advisor) => formatPercent(advisor.verified / advisor.volume),
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
  { title: '客户', dataIndex: 'name', key: 'name', render: (value: string) => <Text strong>{value}</Text> },
  { title: '顾问', dataIndex: 'advisorName', key: 'advisorName', width: 100 },
  { title: '消息数', dataIndex: 'messages', key: 'messages', align: 'right', width: 88 },
  {
    title: '最近活跃',
    dataIndex: 'lastActiveAt',
    key: 'lastActiveAt',
    width: 118,
    render: (value: number) => formatDate(value),
  },
  {
    title: '状态',
    dataIndex: 'activity',
    key: 'activity',
    width: 88,
    render: (value: SamplePatient['activity']) =>
      value === 'active' ? (
        <Tag color="green" bordered={false}>
          活跃
        </Tag>
      ) : (
        <Tag bordered={false}>沉默</Tag>
      ),
  },
];

export default function ReportsPage() {
  const patients = [...SAMPLE_PATIENTS].sort((a, b) => b.messages - a.messages);
  const activePatients = SAMPLE_PATIENTS.filter((patient) => patient.activity === 'active').length;

  return (
    <PageContainer
      header={{
        title: '数据报表',
        subTitle: '服务量、响应时效、核验质量、顾问对比与客户活跃。',
        extra: [<SampleDataTag key="sample" />],
      }}
    >
      <div className="reports-stack">
        <div className="report-summary">
          <div className="report-summary-item">
            <span className="report-summary-label">服务消息</span>
            <span className="report-summary-value">{SAMPLE_TOTALS.volume}</span>
            <span className="report-summary-hint">{SAMPLE_PERIOD_LABEL}</span>
          </div>
          <div className="report-summary-item">
            <span className="report-summary-label">已核验</span>
            <span className="report-summary-value">{SAMPLE_TOTALS.verified}</span>
            <span className="report-summary-hint">通过率 {formatPercent(SAMPLE_PASS_RATE)}</span>
          </div>
          <div className="report-summary-item">
            <span className="report-summary-label">平均响应</span>
            <span className="report-summary-value">
              {SAMPLE_AVG_RESPONSE_SECONDS}
              <span className="report-summary-unit">秒</span>
            </span>
            <span className="report-summary-hint">按服务量加权</span>
          </div>
          <div className="report-summary-item">
            <span className="report-summary-label">覆盖客户</span>
            <span className="report-summary-value">{SAMPLE_TOTALS.patients}</span>
            <span className="report-summary-hint">{activePatients} 位近 7 天内有互动</span>
          </div>
        </div>

        <div className="zb-note">
          本页为预置示例：{SAMPLE_PERIOD_LABEL}，{SAMPLE_ADVISORS.length} 位顾问、{SAMPLE_TOTALS.patients} 位客户、
          {SAMPLE_TOTALS.volume} 条服务消息。顾问合计与趋势合计一致；核验结果四类合计同样为 {SAMPLE_TOTALS.volume} 条。
        </div>

        <div className="reports-chart-grid">
          <Card className="zb-card" variant="borderless" title="服务量与核验趋势">
            <EChart option={serviceVolumeOption} height={280} ariaLabel="服务量与核验趋势" />
          </Card>
          <Card className="zb-card" variant="borderless" title="核验结果构成">
            <EChart option={outcomeOption} height={280} ariaLabel="核验结果构成环形图" />
          </Card>
        </div>

        <div className="reports-chart-grid reports-chart-grid-wide">
          <Card className="zb-card" variant="borderless" title="响应时效（按顾问）">
            <EChart option={responseOption} height={230} ariaLabel="顾问平均响应时长" />
          </Card>
          <Card className="zb-card" variant="borderless" title="口径说明">
            <Paragraph className="report-notes">
              <strong>服务消息</strong>：顾问收到并进入服务流的客户消息数。
            </Paragraph>
            <Paragraph className="report-notes">
              <strong>核验通过率</strong>：已核验草稿 ÷ 已发出草稿；改后发送、发错群、未核验分别计入其余三类。
            </Paragraph>
            <Paragraph className="report-notes">
              <strong>平均响应</strong>：从客户消息到草稿推送的时长，按顾问服务量加权。
            </Paragraph>
            <Paragraph className="report-notes">
              <strong>客户活跃</strong>：近 7 天内有消息来往为活跃；否则标为沉默。示例中沉默客户为 3 位。
            </Paragraph>
          </Card>
        </div>

        <Card className="zb-card" variant="borderless" title="顾问对比">
          <Table<SampleAdvisor>
            rowKey="id"
            size="middle"
            columns={advisorColumns}
            dataSource={SAMPLE_ADVISORS}
            pagination={false}
            scroll={{ x: 960 }}
          />
        </Card>

        <Card className="zb-card" variant="borderless" title="客户活跃">
          <Table<SamplePatient>
            rowKey="id"
            size="middle"
            columns={patientColumns}
            dataSource={patients}
            pagination={false}
            scroll={{ x: 560 }}
          />
        </Card>
      </div>
    </PageContainer>
  );
}
