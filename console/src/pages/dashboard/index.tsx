import {
  AlertOutlined,
  ArrowRightOutlined,
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
  getDashboardTeamAttention,
  getDashboardValue,
} from '../../mock/dashboard.ts';
import { isMockMode } from '../../mock/http.ts';
import { SAMPLE_ADVISORS, SAMPLE_DAYS, SAMPLE_PERIOD_LABEL, SAMPLE_TOTALS } from '../../sample/index.ts';
import type {
  DashboardKpis,
  DashboardRange,
  DashboardValue,
  TeamAttention,
  TeamAttentionPerson,
} from '../../types.ts';
import { formatPercent } from '../../utils/format.ts';
import '../wp-l.css';
import './dashboard.css';

const { Paragraph, Text } = Typography;

const RANGE_LABELS: Record<DashboardRange, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
};

interface DashboardData {
  value: DashboardValue;
  kpis: DashboardKpis;
  attention: TeamAttention;
}

/** 团队关注只跳转，不在首页做催办或处理。 */
function attentionTarget(person: TeamAttentionPerson): string {
  const reason = person.reasons[0];
  if (!reason) return '/alerts';
  const params = new URLSearchParams({ advisorId: person.advisorId });
  switch (reason.code) {
    case 'redline':
    case 'misroute':
    case 'unverified':
      params.set('kind', reason.code);
      return `/alerts?${params.toString()}`;
    case 'advisor_paused':
      if (reason.draftId || reason.patientId) params.set('kind', 'advisor_paused');
      return `/alerts?${params.toString()}`;
    case 'no_reply':
      if (!reason.patientId) return '/patients';
      return `/patients?patientId=${encodeURIComponent(reason.patientId)}&tab=timeline`;
    case 'queue_blocked':
      params.set('status', 'PUSHED');
      return `/service-flow?${params.toString()}`;
    case 'backlog':
    case 'slow_response':
    case 'high_revision':
      return `/service-flow?${params.toString()}`;
    default:
      return '/alerts';
  }
}

function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
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
        const [value, kpis, attention] = await Promise.all([
          getDashboardValue(nextRange),
          getDashboardKpis(nextRange),
          getDashboardTeamAttention(),
        ]);
        setData({ value, kpis, attention });
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

  const { value, kpis, attention } = data;
  const rangeLabel = RANGE_LABELS[range];
  const maxAdvisorVolume = Math.max(1, ...rankingRows.map((advisor) => advisor.volume));
  const attentionPeople = attention.people.slice(0, 8);

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

        <Card
          className="zb-card team-attention-card"
          variant="borderless"
          title={
            <Space size={8}>
              <span>团队关注</span>
              {attention.summary.peopleCount > 0 ? (
                <Tag
                  color={attention.summary.immediateCount > 0 ? 'red' : 'gold'}
                  bordered={false}
                >
                  {attention.summary.peopleCount} 人
                </Tag>
              ) : null}
            </Space>
          }
          extra={
            isMockMode ? (
              <SampleDataTag compact />
            ) : (
              <Text type="secondary">按服务人员聚合</Text>
            )
          }
        >
          {attentionPeople.length === 0 ? (
            <div className="team-attention-empty">
              <CheckCircleOutlined />
              <div>
                <div className="team-attention-empty-title">今天团队运行正常</div>
                <Paragraph type="secondary" style={{ margin: 0 }}>
                  今日已核验 {attention.summary.verifiedToday} 条 · 平均响应{' '}
                  {attention.summary.avgResponseSeconds} 秒 · 未核验{' '}
                  {attention.summary.unverifiedCount} 条
                </Paragraph>
              </div>
            </div>
          ) : (
            <>
              <div className="team-attention-summary">
                <span>
                  今天 <strong>{attention.summary.peopleCount}</strong> 人需要关注
                </span>
                {attention.summary.immediateCount > 0 ? (
                  <span className="team-attention-summary-alert">
                    其中 {attention.summary.immediateCount} 人需立即介入
                  </span>
                ) : null}
                <span className="team-attention-summary-muted">
                  今日已核验 {attention.summary.verifiedToday} 条 · 平均响应{' '}
                  {attention.summary.avgResponseSeconds} 秒 · 未核验{' '}
                  {attention.summary.unverifiedCount} 条
                  {attention.people.length > attentionPeople.length
                    ? ` · 仅显示前 ${attentionPeople.length} 人`
                    : ''}
                </span>
              </div>
              <div className="team-attention-list">
                {attentionPeople.map((person) => (
                  <button
                    type="button"
                    key={person.advisorId}
                    className={`team-attention-row is-${person.level.toLowerCase()}`}
                    onClick={() => navigate(attentionTarget(person))}
                  >
                    <span className="team-attention-avatar">
                      <TeamOutlined />
                    </span>
                    <span className="team-attention-main">
                      <span className="team-attention-head">
                        <Text strong>{person.advisorName}</Text>
                        <Tag
                          color={person.level === 'L1' ? 'red' : 'gold'}
                          bordered={false}
                        >
                          {person.level === 'L1' ? '立即介入' : '今日跟进'}
                        </Tag>
                        <span
                          className={`team-attention-presence ${
                            person.online ? '' : 'is-offline'
                          }`}
                        >
                          {person.online ? '在线' : '离线'}
                        </span>
                        <span className="team-attention-meta">
                          名下 {person.patientCount} 位 · 待处理 {person.pendingCount} 条
                        </span>
                        {person.oldestWaitMinutes > 0 ? (
                          <span className="team-attention-wait">
                            最久等待 {formatWait(person.oldestWaitMinutes)}
                          </span>
                        ) : null}
                      </span>
                      <span className="team-attention-reasons">
                        {person.reasons.slice(0, 2).map((reason) => (
                          <span key={reason.code} className="team-attention-reason">
                            {reason.text}
                          </span>
                        ))}
                        {person.reasons.length > 2 ? (
                          <span className="team-attention-more">
                            另有 {person.reasons.length - 2} 条
                          </span>
                        ) : null}
                      </span>
                      <span className="team-attention-suggestion">
                        建议：{person.suggestion}
                      </span>
                    </span>
                    <span className="team-attention-action">
                      {person.level === 'L1' ? '去处理' : '去查看'}
                      <ArrowRightOutlined />
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="team-attention-foot">
            <Text type="secondary">
              只展示需要管理员介入的行为信号，不展示消息正文与健康数值。
            </Text>
            <Button type="link" onClick={() => navigate('/alerts')}>
              在质检与告警中查看全部事件 <ArrowRightOutlined />
            </Button>
          </div>
        </Card>

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
      </div>
    </PageContainer>
  );
}
