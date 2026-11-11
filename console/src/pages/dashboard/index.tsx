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
import { isMockMode } from '../../mock/http.ts';
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

  // 真实模式只用接口返回的真实数据；示例数据仅在 mock 模式展示。
  const trendPoints = isMockMode
    ? SAMPLE_DAYS.map((day) => ({ label: day.label, volume: day.volume, verified: day.verified }))
    : (data?.value.trend ?? []);
  const rankingRows = isMockMode
    ? [...SAMPLE_ADVISORS]
        .sort((a, b) => b.volume - a.volume)
        .map((advisor) => ({
          id: advisor.id,
          name: advisor.name,
          title: advisor.title,
          volume: advisor.volume,
          verified: advisor.verified,
          avgResponseSeconds: advisor.avgResponseSeconds,
        }))
    : (data?.value.advisorRanking ?? []).map((advisor) => ({
        id: advisor.advisorId,
        name: advisor.name,
        title:
          advisor.status === 'active' ? '在岗' : advisor.status === 'paused' ? '已暂停' : '已离职',
        volume: advisor.volume,
        verified: advisor.verified,
        avgResponseSeconds: advisor.avgResponseSeconds,
      }));
  const trendTotals = trendPoints.reduce(
    (acc, point) => ({ volume: acc.volume + point.volume, verified: acc.verified + point.verified }),
    { volume: 0, verified: 0 },
  );

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
      data: trendPoints.map((day) => day.label),
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
        data: trendPoints.map((day) => day.volume),
        barWidth: 12,
        itemStyle: { color: '#99f6e4', borderRadius: [4, 4, 0, 0] },
      },
      {
        name: '已核验',
        type: 'line',
        data: trendPoints.map((day) => day.verified),
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
  const maxAdvisorVolume = Math.max(1, ...rankingRows.map((advisor) => advisor.volume));

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
              isMockMode ? (
                <Space size={8}>
                  <SampleDataTag compact />
                  <Text type="secondary">{SAMPLE_PERIOD_LABEL}</Text>
                </Space>
              ) : (
                <Text type="secondary">近 14 天 · 会话存档草稿</Text>
              )
            }
          >
            <EChart option={trendOption} height={290} ariaLabel="近 14 天服务消息与已核验趋势" />
            <Paragraph type="secondary" className="chart-footnote">
              {isMockMode
                ? `示例数据：近 14 天共 ${SAMPLE_TOTALS.volume} 条服务消息，其中已核验 ${SAMPLE_TOTALS.verified} 条。`
                : `真实数据：近 14 天共 ${trendTotals.volume} 条草稿，其中已核验 ${trendTotals.verified} 条。`}
            </Paragraph>
          </Card>

          <Card
            className="zb-card"
            variant="borderless"
            title="顾问排行"
            extra={isMockMode ? <SampleDataTag compact /> : <Text type="secondary">当前范围</Text>}
          >
            <div className="advisor-rank">
              {rankingRows.map((advisor, index) => (
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
                        核验通过{' '}
                        {formatPercent(
                          advisor.volume === 0 ? 0 : advisor.verified / advisor.volume,
                        )}{' '}
                        · 平均 {advisor.avgResponseSeconds} 秒
                      </span>
                    </div>
                  </div>
                </div>
              ))}
              {rankingRows.length === 0 ? (
                <Text type="secondary">当前范围暂无顾问草稿。</Text>
              ) : null}
            </div>
            <Paragraph type="secondary" className="chart-footnote">
              {isMockMode
                ? `三位顾问服务量合计 ${SAMPLE_TOTALS.volume} 条，与趋势图一致。`
                : `共 ${rankingRows.length} 位顾问，当前范围草稿合计 ${rankingRows.reduce(
                    (sum, advisor) => sum + advisor.volume,
                    0,
                  )} 条。`}
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
            <CalendarOutlined />{' '}
            {isMockMode
              ? 'KPI 来自接口口径，沙盒数据不计入；趋势、排行与最近动态为示例数据。'
              : 'KPI、趋势、排行与最近动态均来自真实会话存档，沙盒数据不计入。'}
          </Paragraph>
        </Card>
      </div>
    </PageContainer>
  );
}
