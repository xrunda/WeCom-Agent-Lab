import { ExportOutlined, EyeOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
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
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext.tsx';
import { listAdvisors } from '../../mock/advisors.ts';
import { listGroups } from '../../mock/groups.ts';
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
import { listRiskRules } from '../../mock/rules.ts';
import { formatDateTime, formatRelative } from '../../utils/format.ts';
import {
  alertGuidance,
  alertReason,
  alertSourceLabel,
  relatedFlowTarget,
} from './alert-insights.ts';
import { splitByKeywords, splitStaffQuote } from './alert-text.ts';
import './alerts.css';

const { Text } = Typography;

interface AlertActionsProps {
  alert: AlertItem;
  canWrite: boolean;
  includeView?: boolean;
  primary?: boolean;
  onView?: (id: string) => void;
  onResolve: (alert: AlertItem) => void;
  onRelease: (alert: AlertItem) => void;
  onRestore: (alert: AlertItem) => void;
}

function AlertActions({
  alert,
  canWrite,
  includeView = false,
  primary = false,
  onView,
  onResolve,
  onRelease,
  onRestore,
}: AlertActionsProps) {
  const size = primary ? 'middle' : 'small';
  const type = primary ? 'default' : 'link';
  const finished = alert.status === 'resolved';

  return (
    <Space wrap size={4}>
      {includeView && (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => onView?.(alert.id)}>
          查看
        </Button>
      )}
      {!finished &&
        (canWrite ? (
          <>
            <Button
              type={primary ? 'primary' : 'link'}
              size={size}
              onClick={() => onResolve(alert)}
            >
              标记已处理
            </Button>
            {alert.draftId && (
              <Popconfirm
                title="释放阻塞队列？"
                description="会把当前草稿置为已释放，并推送下一条。"
                okText="释放"
                cancelText="取消"
                onConfirm={() => onRelease(alert)}
              >
                <Button type={type} size={size}>
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
                onConfirm={() => onRestore(alert)}
              >
                <Button type={type} size={size}>
                  恢复顾问
                </Button>
              </Popconfirm>
            )}
          </>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            只读
          </Text>
        ))}
    </Space>
  );
}

function asAlertKind(value: string | null): AlertKind | undefined {
  return value && value in ALERT_KIND_LABELS ? (value as AlertKind) : undefined;
}

function asAlertStatus(value: string | null): AlertStatus | undefined {
  return value && value in ALERT_STATUS_LABELS ? (value as AlertStatus) : undefined;
}

export default function AlertsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlKind = searchParams.get('kind');
  const urlStatus = searchParams.get('status');
  const urlAdvisorId = searchParams.get('advisorId') ?? undefined;
  const canWrite = can('alert.write');

  const [items, setItems] = useState<AlertItem[]>([]);
  const [count, setCount] = useState<AlertCount>({ open: 0, acknowledged: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<AlertKind | undefined>(() => asAlertKind(urlKind));
  const [status, setStatus] = useState<AlertStatus | undefined>(() => asAlertStatus(urlStatus));
  const [advisorFilter, setAdvisorFilter] = useState<string | undefined>(urlAdvisorId);
  const [patientNames, setPatientNames] = useState<Record<string, string>>({});
  const [advisorNames, setAdvisorNames] = useState<Record<string, string>>({});
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<AlertItem | null>(null);
  const [note, setNote] = useState('');
  /** 红线关键词：详情里把触发告警的原文词加底色 */
  const [hitKeywords, setHitKeywords] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    listRiskRules({ enabled: true })
      .then(({ items }) => {
        if (!alive) return;
        setHitKeywords(
          items
            .filter((rule) => rule.action === 'flag')
            .flatMap((rule) => rule.keywords),
        );
      })
      .catch(() => {
        // 高亮只是辅助：规则接口不可用时按普通文本展示
      });
    return () => {
      alive = false;
    };
  }, []);

  // 工作台「团队关注」深链：kind / status / advisorId 都从 URL 恢复。
  useEffect(() => {
    setKind(asAlertKind(urlKind));
    setStatus(asAlertStatus(urlStatus));
    setAdvisorFilter(urlAdvisorId);
  }, [urlKind, urlStatus, urlAdvisorId]);

  const clearAdvisorFilter = () => {
    setAdvisorFilter(undefined);
    const next = new URLSearchParams(searchParams);
    next.delete('advisorId');
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, unresolved, patients, advisors, groups] = await Promise.all([
        listAlerts({ kind, status, advisorId: advisorFilter }),
        unresolvedCount(),
        listPatients({ pageSize: 100 }),
        listAdvisors(),
        listGroups({ pageSize: 100 }).catch(() => ({ items: [] })),
      ]);
      setItems(list.items);
      setCount(unresolved);
      setPatientNames(
        Object.fromEntries(patients.items.map((item) => [item.id, item.displayName])),
      );
      setAdvisorNames(Object.fromEntries(advisors.map((item) => [item.id, item.name])));
      setGroupNames(
        Object.fromEntries(groups.items.map((item: { id: string; name: string }) => [item.id, item.name])),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '告警加载失败');
    } finally {
      setLoading(false);
    }
  }, [advisorFilter, kind, status, message]);

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
    const targetId = resolveTarget.id;
    try {
      await resolveAlert(targetId, note);
      message.success('告警已标记为已处理');
      setResolveTarget(null);
      setNote('');
      await load();
      if (detailOpen && detail?.alert.id === targetId) {
        setDetail(await getAlertDetail(targetId));
      }
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
      if (detailOpen && detail?.alert.id === alert.id) {
        setDetail(await getAlertDetail(alert.id));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '释放失败');
    }
  };

  const doRestore = async (alert: AlertItem) => {
    try {
      await restoreAdvisor(alert.id);
      message.success('顾问已恢复接单');
      await load();
      if (detailOpen && detail?.alert.id === alert.id) {
        setDetail(await getAlertDetail(alert.id));
      }
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
        <AlertActions
          alert={alert}
          canWrite={canWrite}
          includeView
          onView={(id) => void openDetail(id)}
          onResolve={(item) => {
            setResolveTarget(item);
            setNote('');
          }}
          onRelease={(item) => void doRelease(item)}
          onRestore={(item) => void doRestore(item)}
        />
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

        {advisorFilter ? (
          <Alert
            type="info"
            showIcon
            message={`已按服务人员筛选：${advisorNames[advisorFilter] ?? advisorFilter}`}
            action={
              <Button size="small" onClick={clearAdvisorFilter}>
                清除人员筛选
              </Button>
            }
          />
        ) : null}

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
          (() => {
            const alert = detail.alert;
            const severity = ALERT_SEVERITY_LABELS[alert.severity];
            const statusColor =
              alert.status === 'open' ? 'red' : alert.status === 'acknowledged' ? 'gold' : 'green';
            const target = relatedFlowTarget(alert);
            return (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Space wrap size={8}>
                  <Tag bordered={false} color={severity.color}>
                    {severity.label}
                  </Tag>
                  <Tag bordered={false} color={statusColor}>
                    {ALERT_STATUS_LABELS[alert.status]}
                  </Tag>
                  <Text type="secondary">{formatDateTime(alert.createdAt)}</Text>
                </Space>

                <Alert
                  type={
                    alert.severity === 'critical'
                      ? 'error'
                      : alert.severity === 'warning'
                        ? 'warning'
                        : 'info'
                  }
                  showIcon
                  message="为什么告警"
                  description={
                    <Space direction="vertical" size={4}>
                      <Text>
                        {(() => {
                          const text = alert.message || alert.title;
                          const parts = splitStaffQuote(text);
                          if (parts.quote === undefined) return text;
                          return (
                            <>
                              {parts.before}
                              {splitByKeywords(parts.quote, hitKeywords).map((segment, index) =>
                                segment.hit ? (
                                  <mark className="alert-hit" key={index}>
                                    {segment.text}
                                  </mark>
                                ) : (
                                  <span key={index}>{segment.text}</span>
                                ),
                              )}
                              {parts.after}
                            </>
                          );
                        })()}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {alertReason(alert.kind, alert.source)}
                      </Text>
                    </Space>
                  }
                />

                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="类型">
                    {ALERT_KIND_LABELS[alert.kind] ?? alert.kind}
                  </Descriptions.Item>
                  <Descriptions.Item label="来源">{alertSourceLabel(alert)}</Descriptions.Item>
                  <Descriptions.Item label="触发时间">
                    {formatDateTime(alert.createdAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="患者">
                    {detail.patient?.displayName ?? '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="顾问">{detail.advisor?.name ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="群">
                    {alert.groupId ? (groupNames[alert.groupId] ?? alert.groupId) : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="升级对象">
                    {alert.escalatedTo ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="草稿" span={2}>
                    {detail.draft ? (
                      <Space direction="vertical" size={2}>
                        <Text strong>{detail.draft.summary}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {detail.draft.id} · {detail.draft.status} · 风险 {detail.draft.riskLevel}
                        </Text>
                      </Space>
                    ) : (
                      <Text type="secondary">无关联草稿</Text>
                    )}
                  </Descriptions.Item>
                </Descriptions>

                <Card size="small" title="处理情况">
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label="处理状态">
                      <Tag bordered={false} color={statusColor}>
                        {ALERT_STATUS_LABELS[alert.status]}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="处理人（账号）">
                      {alert.resolvedBy ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="处理时间">
                      {alert.resolvedAt ? formatDateTime(alert.resolvedAt) : '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="处理备注">
                      {alert.note ?? (alert.status === 'resolved' ? '未填写' : '尚未处理')}
                    </Descriptions.Item>
                  </Descriptions>
                </Card>

                {alert.status !== 'resolved' && (
                  <Alert
                    type="info"
                    showIcon
                    message="怎么处理"
                    description={alertGuidance(alert.kind, alert.source)}
                  />
                )}

                <Space wrap size={8}>
                  <AlertActions
                    alert={alert}
                    canWrite={canWrite}
                    primary
                    onResolve={(item) => {
                      setResolveTarget(item);
                      setNote('');
                    }}
                    onRelease={(item) => void doRelease(item)}
                    onRestore={(item) => void doRestore(item)}
                  />
                  {target ? (
                    <Button icon={<ExportOutlined />} onClick={() => navigate(target.path)}>
                      {target.label}
                    </Button>
                  ) : (
                    <Text type="secondary">
                      该告警没有关联草稿或患者，无法定位到具体服务记录。
                    </Text>
                  )}
                </Space>
              </Space>
            );
          })()
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
