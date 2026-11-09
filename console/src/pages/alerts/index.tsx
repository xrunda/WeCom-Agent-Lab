import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext.tsx';
import { listAdvisors } from '../../mock/advisors.ts';
import {
  ALERT_KIND_LABELS,
  ALERT_SEVERITY_LABELS,
  ALERT_STATUS_LABELS,
  getAlertDetail,
  listAlerts,
  releaseQueue,
  resolveAlert,
  restoreAdvisor,
  subscribeAlerts,
  unresolvedCount,
  type Alert as AlertItem,
  type AlertCount,
  type AlertDetail,
  type AlertKind,
  type AlertStatus,
} from '../../mock/alerts.ts';
import { listPatients } from '../../mock/patients.ts';
import { formatDateTime, formatRelative } from '../../utils/format.ts';
import './alerts.css';

const { Text } = Typography;

export default function AlertsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const canWrite = can('alert.write');

  const [items, setItems] = useState<AlertItem[]>([]);
  const [count, setCount] = useState<AlertCount>({ open: 0, acknowledged: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<AlertKind | undefined>();
  const [status, setStatus] = useState<AlertStatus | undefined>();
  const [patientNames, setPatientNames] = useState<Record<string, string>>({});
  const [advisorNames, setAdvisorNames] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<AlertItem | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, unresolved, patients, advisors] = await Promise.all([
        listAlerts({ kind, status }),
        unresolvedCount(),
        listPatients({ pageSize: 100 }),
        listAdvisors(),
      ]);
      setItems(list.items);
      setCount(unresolved);
      setPatientNames(
        Object.fromEntries(patients.items.map((item) => [item.id, item.displayName])),
      );
      setAdvisorNames(Object.fromEntries(advisors.map((item) => [item.id, item.name])));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '告警加载失败');
    } finally {
      setLoading(false);
    }
  }, [kind, status, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeAlerts(() => {
      void load();
    });
    return unsubscribe;
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailOpen(true);
    setDetail(null);
    try {
      setDetail(await getAlertDetail(id));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '详情加载失败');
    }
  };

  const submitResolve = async () => {
    if (!resolveTarget) return;
    try {
      await resolveAlert(resolveTarget.id, note);
      message.success('告警已标记为已处理');
      setResolveTarget(null);
      setNote('');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '处理失败');
    }
  };

  const doRelease = async (alert: AlertItem) => {
    try {
      const result = await releaseQueue(alert.id);
      message.success(
        `已释放 ${result.releasedDraftId}${
          result.nextDraftId ? `，下一条 ${result.nextDraftId} 已推送` : ''
        }`,
      );
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '释放失败');
    }
  };

  const doRestore = async (alert: AlertItem) => {
    try {
      await restoreAdvisor(alert.id);
      message.success('顾问已恢复接单');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '恢复失败');
    }
  };

  const columns: TableProps<AlertItem>['columns'] = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 130,
      render: (value: AlertKind, alert) => (
        <Space direction="vertical" size={2}>
          <Tag bordered={false} color={ALERT_SEVERITY_LABELS[alert.severity].color}>
            {ALERT_SEVERITY_LABELS[alert.severity].label}
          </Tag>
          <Text>{ALERT_KIND_LABELS[value] ?? value}</Text>
        </Space>
      ),
    },
    {
      title: '标题 / 说明',
      key: 'title',
      render: (_, alert) => (
        <Space direction="vertical" size={2}>
          <Text strong>{alert.title}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {alert.message}
          </Text>
        </Space>
      ),
    },
    {
      title: '关联',
      key: 'related',
      width: 170,
      render: (_, alert) => (
        <Space direction="vertical" size={2}>
          <Text>{alert.patientId ? (patientNames[alert.patientId] ?? alert.patientId) : '-'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {alert.advisorId ? (advisorNames[alert.advisorId] ?? alert.advisorId) : '无顾问'}
          </Text>
        </Space>
      ),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 130,
      render: (value: number) => (
        <Space direction="vertical" size={0}>
          <Text>{formatRelative(value)}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {formatDateTime(value)}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: AlertStatus) => (
        <Tag
          bordered={false}
          color={value === 'open' ? 'red' : value === 'acknowledged' ? 'gold' : 'default'}
        >
          {ALERT_STATUS_LABELS[value]}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 250,
      render: (_, alert) => (
        <Space wrap size={4}>
          <Button type="link" size="small" onClick={() => void openDetail(alert.id)}>
            查看
          </Button>
          {canWrite && alert.status !== 'resolved' && (
            <>
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setResolveTarget(alert);
                  setNote('');
                }}
              >
                标记已处理
              </Button>
              {alert.draftId && (
                <Popconfirm
                  title="释放阻塞队列？"
                  description="会把当前草稿置为已释放，并推送下一条。"
                  okText="释放"
                  cancelText="取消"
                  onConfirm={() => void doRelease(alert)}
                >
                  <Button type="link" size="small">
                    释放队列
                  </Button>
                </Popconfirm>
              )}
              {alert.kind === 'advisor_paused' && (
                <Popconfirm
                  title="恢复顾问接单？"
                  description="恢复后连续错群计数会清零。"
                  okText="恢复"
                  cancelText="取消"
                  onConfirm={() => void doRestore(alert)}
                >
                  <Button type="link" size="small">
                    恢复顾问
                  </Button>
                </Popconfirm>
              )}
            </>
          )}
          {!canWrite && alert.status !== 'resolved' && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              只读
            </Text>
          )}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      header={{
        title: '质检与告警',
        subTitle: '发错群、未核验、超时升级、死信、顾问暂停与红线命中，都在这里处理。',
      }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={16} style={{ width: '100%' }}>
          <Card variant="borderless" style={{ minWidth: 160 }}>
            <Statistic
              title="待处理"
              value={count.open}
              valueStyle={{ color: count.open > 0 ? '#cf1322' : undefined }}
            />
          </Card>
          <Card variant="borderless" style={{ minWidth: 160 }}>
            <Statistic title="处理中" value={count.acknowledged} />
          </Card>
          <Card variant="borderless" style={{ minWidth: 160 }}>
            <Statistic title="未处理合计" value={count.total} />
          </Card>
        </Space>

        <Card variant="borderless">
          <Space wrap size={12}>
            <Select
              allowClear
              placeholder="全部类型"
              style={{ width: 160 }}
              value={kind}
              onChange={setKind}
              options={Object.entries(ALERT_KIND_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Select
              allowClear
              placeholder="全部状态"
              style={{ width: 140 }}
              value={status}
              onChange={setStatus}
              options={Object.entries(ALERT_STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Text type="secondary">共 {items.length} 条</Text>
          </Space>
        </Card>

        <Table<AlertItem>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 1000 }}
        />
      </Space>

      <Drawer
        width={720}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title="告警详情"
        destroyOnHidden
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="类型">
                {ALERT_KIND_LABELS[detail.alert.kind] ?? detail.alert.kind}
              </Descriptions.Item>
              <Descriptions.Item label="严重度">
                <Tag color={ALERT_SEVERITY_LABELS[detail.alert.severity].color}>
                  {ALERT_SEVERITY_LABELS[detail.alert.severity].label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                {ALERT_STATUS_LABELS[detail.alert.status]}
              </Descriptions.Item>
              <Descriptions.Item label="时间">
                {formatDateTime(detail.alert.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="患者">
                {detail.patient?.displayName ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="顾问">{detail.advisor?.name ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="草稿" span={2}>
                {detail.draft ? (
                  <Space direction="vertical" size={2}>
                    <Text strong>{detail.draft.summary}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {detail.draft.id} · {detail.draft.status} · 风险 {detail.draft.riskLevel}
                    </Text>
                  </Space>
                ) : (
                  '无关联草稿'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="处理备注" span={2}>
                {detail.alert.note ?? '未填写'}
              </Descriptions.Item>
            </Descriptions>
            <Text type="secondary">{detail.alert.message}</Text>
            <Button onClick={() => navigate('/service-flow')}>去服务流查看</Button>
          </Space>
        ) : (
          <Empty description="正在加载详情…" />
        )}
      </Drawer>

      <Modal
        open={Boolean(resolveTarget)}
        title={
          <Space>
            <WarningOutlined />
            标记已处理
          </Space>
        }
        okText="确认处理"
        cancelText="取消"
        onCancel={() => setResolveTarget(null)}
        onOk={() => void submitResolve()}
      >
        {resolveTarget && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text strong>{resolveTarget.title}</Text>
            <Text type="secondary">{resolveTarget.message}</Text>
            <Input.TextArea
              rows={3}
              maxLength={200}
              showCount
              placeholder="填写处理备注（必填，≤200 字）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Space>
        )}
      </Modal>
    </PageContainer>
  );
}
