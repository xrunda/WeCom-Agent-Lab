import { PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Popconfirm,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth, useTenantSettings } from '../../auth/AuthContext.tsx';
import { SampleDataTag } from '../../components/SampleDataTag.tsx';
import { isMockMode } from '../../mock/http.ts';
import { formatDate } from '../../utils/format.ts';
import {
  ADVISOR_STATUS_LABELS,
  listAdvisors,
  pauseAdvisor,
  resumeAdvisor,
  samplePerformance,
  seatCost,
  type Advisor,
  type AdvisorPerformanceRow,
} from '../../mock/advisors.ts';

const { Text } = Typography;

const DEFAULT_SEAT_PRICE = 900;

export default function AdvisorsPage() {
  const { can } = useAuth();
  const settings = useTenantSettings();
  const { message } = App.useApp();
  const canPause = can('advisor.operate');

  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const pricePerSeat = settings?.archiveSeatPriceYuan ?? DEFAULT_SEAT_PRICE;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAdvisors()
      .then((items) => {
        if (!cancelled) setAdvisors(items);
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
  }, [refreshKey, message]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const cost = useMemo(() => seatCost(advisors, pricePerSeat), [advisors, pricePerSeat]);
  const nearestExpire = useMemo(() => {
    const dates = advisors
      .map((item) => item.seatExpireAt)
      .filter((value): value is number => typeof value === 'number');
    return dates.length > 0 ? Math.min(...dates) : null;
  }, [advisors]);

  const togglePause = async (advisor: Advisor) => {
    try {
      if (advisor.status === 'paused') {
        await resumeAdvisor(advisor.id);
        message.success(`${advisor.name} 已恢复接单`);
      } else {
        await pauseAdvisor(advisor.id);
        message.success(`${advisor.name} 已暂停，队列中的草稿会转给其他顾问`);
      }
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const columns: TableProps<Advisor>['columns'] = [
    {
      title: '顾问',
      dataIndex: 'name',
      render: (value: string, advisor) => (
        <Space size={6} wrap>
          <Text strong>{value}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {advisor.wecomUserId}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: Advisor['status']) => (
        <Tag
          bordered={false}
          color={value === 'active' ? 'green' : value === 'paused' ? 'gold' : 'default'}
        >
          {ADVISOR_STATUS_LABELS[value]}
        </Tag>
      ),
    },
    {
      title: '在线',
      dataIndex: 'online',
      width: 90,
      render: (value: boolean) => (
        <Tag bordered={false} color={value ? 'green' : 'default'}>
          {value ? '在线' : '离线'}
        </Tag>
      ),
    },
    {
      title: '当前队列',
      dataIndex: 'queueDepth',
      width: 100,
      render: (value: number) => (value > 0 ? <Text strong>{value} 条</Text> : '0'),
    },
    {
      title: '连续错群',
      dataIndex: 'consecutiveMisroutes',
      width: 100,
      render: (value: number) =>
        value > 0 ? (
          <Tag bordered={false} color="red">
            {value} 次
          </Tag>
        ) : (
          <Text type="secondary">0</Text>
        ),
    },
    {
      title: '席位到期',
      dataIndex: 'seatExpireAt',
      width: 130,
      render: (value: number | null) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_, advisor) => {
        if (advisor.status === 'left') return <Text type="secondary">已离职</Text>;
        if (!canPause) return <Text type="secondary">只读</Text>;
        return advisor.status === 'paused' ? (
          <Popconfirm
            title={`恢复 ${advisor.name}？`}
            description="恢复后会重新接收草稿。"
            okText="恢复"
            cancelText="取消"
            onConfirm={() => void togglePause(advisor)}
          >
            <Button type="link" size="small" icon={<PlayCircleOutlined />}>
              恢复
            </Button>
          </Popconfirm>
        ) : (
          <Popconfirm
            title={`暂停 ${advisor.name}？`}
            description="暂停后队列中的草稿会转给其他顾问。"
            okText="暂停"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void togglePause(advisor)}
          >
            <Button type="link" size="small" danger icon={<PauseCircleOutlined />}>
              暂停
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  const performanceColumns: TableProps<AdvisorPerformanceRow>['columns'] = [
    { title: '顾问', dataIndex: 'name' },
    {
      title: '已发出草稿',
      dataIndex: 'draftsSent',
      render: (value: number) => `${value} 条`,
    },
    {
      title: 'AI 采纳率',
      dataIndex: 'adoptionRate',
      render: (value: number) => `${Math.round(value * 100)}%`,
    },
    {
      title: '平均响应',
      dataIndex: 'avgResponseSeconds',
      render: (value: number) => `${Math.round(value / 60)} 分钟`,
    },
    {
      title: '错群次数',
      dataIndex: 'misroutes',
      render: (value: number) =>
        value > 0 ? (
          <Tag bordered={false} color="red">
            {value}
          </Tag>
        ) : (
          '0'
        ),
    },
  ];

  return (
    <PageContainer
      header={{
        title: '顾问',
        subTitle: '席位、在线状态与队列；暂停后草稿会转给其他顾问。',
      }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={16} style={{ width: '100%' }}>
          <Card variant="borderless" style={{ minWidth: 180 }}>
            <Statistic title="已购席位" value={cost.seats} suffix="席" />
          </Card>
          <Card variant="borderless" style={{ minWidth: 220 }}>
            <Statistic
              title="年席位成本"
              value={cost.annualCost}
              prefix="¥"
              precision={0}
              suffix="/ 年"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {cost.seats} 席 × ¥{cost.pricePerSeat} / 人 / 年
            </Text>
          </Card>
          <Card variant="borderless" style={{ minWidth: 200 }}>
            <Statistic title="最近席位到期" value={nearestExpire ? formatDate(nearestExpire) : '-'} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              单价来自租户设置，可在「系统设置」调整
            </Text>
          </Card>
        </Space>

        <Tabs
          items={[
            {
              key: 'list',
              label: '顾问列表',
              children: (
                <Table<Advisor>
                  rowKey="id"
                  size="middle"
                  loading={loading}
                  columns={columns}
                  dataSource={advisors}
                  pagination={{ pageSize: 10, hideOnSinglePage: true }}
                  scroll={{ x: 900 }}
                />
              ),
            },
            {
              key: 'performance',
              label: '绩效',
              children: isMockMode ? (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type="info"
                    showIcon
                    message={
                      <Space size={8}>
                        <span>绩效为 B 档示例数据</span>
                        <SampleDataTag compact />
                      </Space>
                    }
                    description="真实绩效口径见数据模型 §5；当前数据仅用于展示布局。"
                  />
                  <Table<AdvisorPerformanceRow>
                    rowKey="advisorId"
                    size="middle"
                    columns={performanceColumns}
                    dataSource={samplePerformance(advisors)}
                    pagination={false}
                  />
                </Space>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message="绩效统计尚未接入真实数据"
                  description="真实模式下不展示示例绩效数字，避免与真实运营数据混淆。接入前请以服务流与审计日志为准。"
                />
              ),
            },
          ]}
        />
      </Space>
    </PageContainer>
  );
}
