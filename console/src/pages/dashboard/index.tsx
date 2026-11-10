import {
  AlertOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  RobotOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Card, Progress, Segmented, Space, Spin, Tag, Typography } from 'antd';
import type { EChartsOption } from 'echarts';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { EChart } from '../../components/EChart.tsx';
import { SampleDataTag } from '../../components/SampleDataTag.tsx';
import { ValueBar } from './ValueBar.tsx';
import { useTerm } from '../../auth/AuthContext.tsx';
import {
  getDashboardKpis,
  getDashboardRecent,
  getDashboardValue,
} from '../../mock/dashboard.ts';
import { SAMPLE_ADVISORS, SAMPLE_DAYS, SAMPLE_PERIOD_LABEL, SAMPLE_TOTALS } from '../../sample/index.ts';
import type {
  DashboardKpis,
  DashboardRange,
  DashboardRecentItem,
  DashboardValue,
} from '../../types.ts';
import { formatPercent, formatRelative } from '../../utils/format.ts';
import '../wp-l.css';
import './dashboard.css';

const { Paragraph, Text } = Typography;

const RANGE_LABELS: Record<DashboardRange, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
};

const OUTCOME_META: Record<
  DashboardRecentItem['outcome'],
  { label: string; color: string }
> = {
  verified: { label: '已核验', color: 'green' },
  edit_sent: { label: '改后发送', color: 'blue' },
  misroute: { label: '发错群', color: 'red' },
  unverified: { label: '未核验', color: 'orange' },
  pending: { label: '待核验', color: 'gold' },
};

interface DashboardData {
  value: DashboardValue;
  kpis: DashboardKpis;
  recent: DashboardRecentItem[];
}

export default function DashboardPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const term = useTerm();
  const [range, setRange] = useState<DashboardRange>('today');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (nextRange: DashboardRange) => {
      setLoading(true);
      try {
        const [value, kpis, recent] = await Promise.all([
          getDashboardValue(nextRange),
          getDashboardKpis(nextRange),
          getDashboardRecent(8),
        ]);
        setData({ value, kpis, recent: recent.items });
      } catch (error) {
        message.error(error instanceof Error ? error.message : '工作台加载失败');
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    void load(range);
  }, [load, range]);

  const trendOption: EChartsOption = {
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

  if (!data) {
    return (
      <div className="app-loading" style={{ minHeight: 360 }}>
        <Spin />
        <div className="zb-muted" style={{ marginTop: 12 }}>正在加载工作台…</div>
      </div>
    );
  }

  const { value, kpis, recent } = data;
  const rangeLabel = RANGE_LABELS[range];
  const maxAdvisorVolume = Math.max(...SAMPLE_ADVISORS.map((advisor) => advisor.volume));

  return (
    <PageContainer
      header={{
        title: '工作台',
        subTitle: '第一眼看清服务规模、核验质量与团队状态。',
        extra: [
          loading ? (
            <Text key="loading" type="secondary">
              更新中…
            </Text>
          ) : null,
          <Segmented<DashboardRange>
            key="range"
            value={range}
            onChange={(next) => setRange(next)}
            options={[
              { value: 'today', label: '今日' },
              { value: 'week', label: '本周' },
              { value: 'month', label: '本月' },
            ]}
          />,
        ],
      }}
    >
      <div className="dashboard-stack">
        <ValueBar
          value={value}
          rangeLabel={rangeLabel}
          onRefresh={() => void load(range)}
          onOpenOnboarding={() => navigate('/settings/onboarding')}
        />

        <div className="kpi-grid">
          <div className="zb-kpi-card">
            <span className="zb-kpi-label">在线 Agent</span>
            <span className="zb-kpi-value">
              {kpis.onlineAgents}
              <span className="zb-kpi-unit">个</span>
            </span>
            <span className="zb-kpi-hint">
              <RobotOutlined /> 覆盖 {value.patientsPerAdvisor.toFixed(1)} 位{term}/顾问
            </span>
          </div>
          <div className="zb-kpi-card">
            <span className="zb-kpi-label">{rangeLabel}主动关怀</span>
            <span className="zb-kpi-value">
              {kpis.proactiveToday}
              <span className="zb-kpi-unit">条</span>
            </span>
            <span className="zb-kpi-hint">
              <ThunderboltOutlined /> 按计划主动起草
            </span>
          </div>
          <div className="zb-kpi-card">
            <span className="zb-kpi-label">{rangeLabel}新增记忆</span>
            <span className="zb-kpi-value">
              {kpis.memoriesToday}
              <span className="zb-kpi-unit">条</span>
            </span>
            <span className="zb-kpi-hint">
              <DatabaseOutlined /> 可查、可改、可删
            </span>
          </div>
          <div className="zb-kpi-card">
            <span className="zb-kpi-label">{rangeLabel}草稿</span>
            <span className="zb-kpi-value">
              {kpis.draftsToday}
              <span className="zb-kpi-unit">条</span>
            </span>
            <span className="zb-kpi-hint">
              <FileTextOutlined /> 沙盒数据不计入
            </span>
          </div>
          <div className="zb-kpi-card">
            <span className="zb-kpi-label">核验通过率</span>
            <span className="zb-kpi-value">{formatPercent(kpis.verificationPassRate)}</span>
            <span className="zb-kpi-hint">
              <CheckCircleOutlined /> 已核验 / 已发出
            </span>
          </div>
          <div className="zb-kpi-card">
            <span className="zb-kpi-label">平均响应</span>
            <span className="zb-kpi-value">
              {kpis.avgResponseSeconds}
              <span className="zb-kpi-unit">秒</span>
            </span>
            <span className="zb-kpi-hint">
              <ClockCircleOutlined /> 从消息到草稿推送
            </span>
          </div>
          <button type="button" className="zb-kpi-card kpi-alert-card" onClick={() => navigate('/alerts')}>
            <span className="zb-kpi-label">未处理告警</span>
            <span className={`zb-kpi-value ${kpis.openAlerts > 0 ? 'kpi-alert-value' : ''}`}>
              {kpis.openAlerts}
              <span className="zb-kpi-unit">条</span>
            </span>
            <span className="zb-kpi-hint">
              <AlertOutlined /> 去质检与告警处理
            </span>
          </button>
        </div>

        <div className="dashboard-two-col">
          <Card
            className="zb-card"
            variant="borderless"
            title="服务量趋势"
            extra={
              <Space size={8}>
                <SampleDataTag compact />
                <Text type="secondary">{SAMPLE_PERIOD_LABEL}</Text>
              </Space>
            }
          >
            <EChart option={trendOption} height={290} ariaLabel="近 14 天服务消息与已核验趋势" />
            <Paragraph type="secondary" className="chart-footnote">
              示例数据：近 14 天共 {SAMPLE_TOTALS.volume} 条服务消息，其中已核验 {SAMPLE_TOTALS.verified} 条。
            </Paragraph>
          </Card>

          <Card
            className="zb-card"
            variant="borderless"
            title="顾问排行"
            extra={<SampleDataTag compact />}
          >
            <div className="advisor-rank">
              {[...SAMPLE_ADVISORS]
                .sort((a, b) => b.volume - a.volume)
                .map((advisor, index) => (
                  <div key={advisor.id} className="advisor-rank-row">
                    <span className={`rank-index rank-${index + 1}`}>{index + 1}</span>
                    <div className="advisor-rank-main">
                      <div className="advisor-rank-head">
                        <Text strong>{advisor.name}</Text>
                        <Text type="secondary">{advisor.volume} 条</Text>
                      </div>
                      <Progress
                        percent={Math.round((advisor.volume / maxAdvisorVolume) * 100)}
                        showInfo={false}
                        strokeColor={index === 0 ? '#0f766e' : '#5eead4'}
                        trailColor="#eef2f7"
                        size="small"
                      />
                      <div className="advisor-rank-foot">
                        <span>{advisor.title}</span>
                        <span>
                          核验通过 {formatPercent(advisor.verified / advisor.volume)} · 平均{' '}
                          {advisor.avgResponseSeconds} 秒
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
            <Paragraph type="secondary" className="chart-footnote">
              三位顾问服务量合计 {SAMPLE_TOTALS.volume} 条，与趋势图一致。
            </Paragraph>
          </Card>
        </div>

        <Card
          className="zb-card"
          variant="borderless"
          title="最近服务动态"
          extra={
            <Button type="link" onClick={() => navigate('/service-flow')}>
              查看实时服务流
            </Button>
          }
        >
          <div className="recent-list">
            {recent.map((item) => {
              const meta = OUTCOME_META[item.outcome] ?? OUTCOME_META.pending;
              return (
                <button
                  type="button"
                  key={item.id}
                  className="recent-row"
                  onClick={() => navigate('/service-flow')}
                >
                  <span className="recent-avatar">
                    <TeamOutlined />
                  </span>
                  <span className="recent-main">
                    <span className="recent-title">
                      <Text strong>{item.patientName}</Text>
                      <Tag color={meta.color} bordered={false}>
                        {meta.label}
                      </Tag>
                      {item.sandbox ? (
                        <Tag color="purple" bordered={false}>
                          沙盒
                        </Tag>
                      ) : null}
                    </span>
                    <span className="recent-meta">
                      {item.advisorName} · {item.groupName} · {item.preview}
                    </span>
                  </span>
                  <span className="recent-time">{formatRelative(item.at)}</span>
                </button>
              );
            })}
          </div>
          <Paragraph type="secondary" className="chart-footnote">
            <CalendarOutlined /> KPI 来自接口口径，沙盒数据不计入；趋势、排行与最近动态为示例数据。
          </Paragraph>
        </Card>
      </div>
    </PageContainer>
  );
}
