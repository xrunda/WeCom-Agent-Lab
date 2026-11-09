import { App, Empty, Spin, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useEffect, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import {
  ACTION_RESULT_LABELS,
  AGENT_TOOL_LABELS,
  listActions,
  type AgentAction,
} from '../../../mock/patients.ts';

const { Text } = Typography;

const RESULT_COLORS: Record<AgentAction['result'], string> = {
  success: 'green',
  failed: 'red',
  skipped: 'default',
};

export function ActionsTab({ patientId }: { patientId: string }) {
  const { message } = App.useApp();
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listActions(patientId)
      .then((items) => {
        if (!cancelled) setActions(items);
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

  const columns: TableProps<AgentAction>['columns'] = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: number) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '工具',
      dataIndex: 'tool',
      width: 130,
      render: (value: AgentAction['tool']) => <Tag bordered={false}>{AGENT_TOOL_LABELS[value]}</Tag>,
    },
    {
      title: '结果摘要',
      dataIndex: 'summary',
      render: (value: string) => value,
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 90,
      render: (value: AgentAction['result']) => (
        <Tag bordered={false} color={RESULT_COLORS[value]}>
          {ACTION_RESULT_LABELS[value]}
        </Tag>
      ),
    },
    {
      title: '关联草稿',
      dataIndex: 'draftId',
      width: 130,
      render: (value: string | null) => (value ? <Text code>{value}</Text> : '-'),
    },
  ];

  return loading ? (
    <div style={{ padding: '48px 0', textAlign: 'center' }}>
      <Spin tip="正在加载办事记录…" />
    </div>
  ) : actions.length === 0 ? (
    <Empty description="这位患者还没有 Agent 办事记录" />
  ) : (
    <Table<AgentAction>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={actions}
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
    />
  );
}
