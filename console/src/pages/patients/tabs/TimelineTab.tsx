import { App, Empty, Space, Spin, Tag, Timeline, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import { getTimeline, type TimelineEvent } from '../../../mock/patients.ts';

const { Text } = Typography;

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
  return 'gray';
}

export function TimelineTab({ patientId }: { patientId: string }) {
  const { message } = App.useApp();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTimeline(patientId)
      .then((items) => {
        if (!cancelled) setEvents(items);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, message]);

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin tip="正在加载对话时间线…" />
      </div>
    );
  }

  if (events.length === 0) {
    return <Empty description="还没有对话与草稿记录" />;
  }

  return (
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
  );
}
