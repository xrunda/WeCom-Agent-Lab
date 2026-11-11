import { ReloadOutlined } from '@ant-design/icons';
import { App, Button, Empty, Pagination, Space, Spin, Tag, Timeline, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import { getTimeline, type TimelineEvent } from '../../../mock/patients.ts';

const { Text } = Typography;

const PAGE_SIZE = 20;
/** 页面打开期间静默刷新，避免顾问一直盯着旧时间线 */
const REFRESH_INTERVAL_MS = 30_000;

const TYPE_LABELS: Record<TimelineEvent['type'], string> = {
  inbound: '客户消息',
  draft: 'Agent 草稿',
  revision: '顾问改稿',
  delivery: '实际发送',
  verification: '核验结果',
  memory: '记忆变更',
  care_plan: '计划变更',
  alert: '风险告警',
  note: '备注',
};

const ACTOR_LABELS: Record<TimelineEvent['actor']['type'], string> = {
  patient: '客户',
  agent: 'Agent',
  advisor: '顾问',
  system: '系统',
};

const VERIFICATION_COLORS: Record<NonNullable<TimelineEvent['verificationOutcome']>, string> = {
  verified: 'green',
  edit_sent: 'blue',
  misroute: 'red',
  unverified: 'orange',
};

function colorOf(event: TimelineEvent): string {
  if (event.type === 'verification' && event.verificationOutcome) {
    return VERIFICATION_COLORS[event.verificationOutcome];
  }
  if (event.type === 'inbound') return 'blue';
  if (event.type === 'draft') return 'geekblue';
  if (event.type === 'revision') return 'purple';
  if (event.type === 'delivery') return 'green';
  if (event.type === 'memory' && event.title === '修正记忆') return 'gold';
  return 'gray';
}

export function TimelineTab({ patientId }: { patientId: string }) {
  const { message } = App.useApp();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (targetPage: number, silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const result = await getTimeline(patientId, targetPage, PAGE_SIZE);
        setEvents(result.items);
        setTotal(result.total);
        // 刷新后当前页已经没有数据（例如记录被删），回到第一页
        if (result.items.length === 0 && result.total > 0 && targetPage > 1) {
          setPage(1);
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : '加载失败');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [patientId, message],
  );

  useEffect(() => {
    setEvents([]);
    setTotal(0);
    setPage(1);
    setLoading(true);
  }, [patientId]);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  // 停留在第一页时静默刷新，让新消息和记忆修正能自动出现
  useEffect(() => {
    if (page !== 1) return;
    const timer = setInterval(() => {
      void load(1, true);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, page]);

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin tip="正在加载对话时间线…" />
      </div>
    );
  }

  if (total === 0) {
    return <Empty description="还没有对话与草稿记录" />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text type="secondary">共 {total} 条 · 最新在前</Text>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={refreshing}
          onClick={() => void load(page, true)}
        >
          刷新
        </Button>
      </div>

      <Timeline
        items={events.map((event) => ({
          key: event.id,
          color: colorOf(event),
          children: (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space size={8} wrap>
                <Text strong>{event.title}</Text>
                <Tag bordered={false}>{TYPE_LABELS[event.type]}</Tag>
                {event.verificationOutcome ? (
                  <Tag bordered={false} color={VERIFICATION_COLORS[event.verificationOutcome]}>
                    {event.verificationOutcome === 'verified'
                      ? '已核验'
                      : event.verificationOutcome === 'edit_sent'
                        ? '改后发送'
                        : event.verificationOutcome === 'misroute'
                          ? '发错群'
                          : '未核验'}
                  </Tag>
                ) : null}
              </Space>
              {event.detail ? <Text>{event.detail}</Text> : null}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {formatDateTime(event.at)} · {ACTOR_LABELS[event.actor.type]}：{event.actor.name}
                {event.draftId ? ` · 草稿 ${event.draftId}` : ''}
              </Text>
            </Space>
          ),
        }))}
      />

      {total > PAGE_SIZE ? (
        <Pagination
          size="small"
          current={page}
          pageSize={PAGE_SIZE}
          total={total}
          showSizeChanger={false}
          onChange={setPage}
        />
      ) : null}
    </Space>
  );
}
