import {
  EyeOutlined,
  FilePdfOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Image,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import { listAdvisors } from '../../mock/advisors.ts';
import {
  MOCK_EXPORT_NOTICE,
  exportDraftEvidencePdf,
  isMockOnly,
} from '../../mock/exports.ts';
import { listGroups } from '../../mock/groups.ts';
import { isMockMode } from '../../mock/http.ts';
import { mediaKindLabel, type MediaKind } from '../../mock/media.ts';
import {
  FLOW_STATUS_META,
  RISK_LABELS,
  SOURCE_LABELS,
  getServiceFlowDetail,
  listServiceFlow,
  subscribeServiceFlow,
  type FlowDetail,
  type FlowEvent,
  type ServiceFlowRow,
} from '../../mock/service-flow.ts';
import { formatDateTime } from '../../utils/format.ts';
import { diffSegments } from './diff.ts';
import './service-flow.css';

const { Text, Paragraph } = Typography;

const UNSUPPORTED_KINDS: MediaKind[] = ['voice', 'file', 'video'];

/** 已进入发送/核验阶段的草稿才提供证据链导出 */
const EVIDENCE_STATUSES = new Set([
  'VERIFIED',
  'EDIT_SENT',
  'MISROUTE_ALERT',
  'UNVERIFIED',
  'RELEASED',
  'DEAD_LETTER',
]);

interface Filters {
  groupId?: string;
  advisorId?: string;
  status?: string;
  riskLevel?: string;
  source?: string;
  range: [Dayjs, Dayjs] | null;
}

const EMPTY_FILTERS: Filters = {
  groupId: undefined,
  advisorId: undefined,
  status: undefined,
  riskLevel: undefined,
  source: undefined,
  range: null,
};

function formatDuration(ms?: number): string {
  if (ms === undefined) return '-';
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function totalDuration(row: ServiceFlowRow): number | undefined {
  const values = Object.values(row.durations).filter(
    (value): value is number => typeof value === 'number',
  );
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

export default function ServiceFlowPage() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<ServiceFlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const [ticker, setTicker] = useState<FlowEvent[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [advisors, setAdvisors] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [version, setVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listServiceFlow({
        groupId: filters.groupId,
        advisorId: filters.advisorId,
        status: filters.status,
        riskLevel: filters.riskLevel,
        source: filters.source,
        from: filters.range?.[0].startOf('day').valueOf(),
        to: filters.range?.[1].endOf('day').valueOf(),
        pageSize: 50,
      });
      setRows(result.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '服务流加载失败');
    } finally {
      setLoading(false);
    }
  }, [filters, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportEvidence = useCallback(
    async (draftId: string) => {
      setExporting(true);
      try {
        await exportDraftEvidencePdf(draftId);
        message.success('已开始下载证据链 PDF');
      } catch (error) {
        if (isMockOnly(error)) message.info(MOCK_EXPORT_NOTICE);
        else message.error(error instanceof Error ? error.message : '导出失败');
      } finally {
        setExporting(false);
      }
    },
    [message],
  );

  useEffect(() => {
    let active = true;
    Promise.all([listGroups(), listAdvisors()])
      .then(([groupResult, advisorList]) => {
        if (!active) return;
        setGroups(groupResult.items.map((item) => ({ id: item.id, name: item.name })));
        setAdvisors(advisorList.map((item) => ({ id: item.id, name: item.name })));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    const unsubscribe = subscribeServiceFlow(({ event }) => {
      setTicker((current) => [event, ...current].slice(0, 8));
      void load();
    });
    return unsubscribe;
  }, [live, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    getServiceFlowDetail(selectedId)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setVersion(result.draft.revisions.at(-1)?.version ?? result.draft.version);
      })
      .catch((error: unknown) => {
        if (active) message.error(error instanceof Error ? error.message : '详情加载失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId, message]);

  const columns: TableProps<ServiceFlowRow>['columns'] = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 108,
      render: (value: number) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 96,
      render: (value: ServiceFlowRow['source']) => (
        <Tag bordered={false} color={value === 'proactive' ? 'purple' : 'blue'}>
          {SOURCE_LABELS[value]}
        </Tag>
      ),
    },
    {
      title: '群 / 患者',
      key: 'group',
      width: 190,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.groupName}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.patientName} · {row.advisorName}
          </Text>
        </Space>
      ),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      ellipsis: true,
      render: (value: string) => <Text ellipsis={{ tooltip: value }}>{value}</Text>,
    },
    {
      title: '图片',
      dataIndex: 'mediaKinds',
      width: 126,
      render: (kinds: MediaKind[]) => <MediaCell kinds={kinds} />,
    },
    {
      title: '风险',
      dataIndex: 'riskLevel',
      width: 90,
      render: (value: ServiceFlowRow['riskLevel']) => (
        <Tag bordered={false} color={RISK_LABELS[value].color}>
          {RISK_LABELS[value].label}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 140,
      render: (value: ServiceFlowRow['status']) => (
        <Badge status={FLOW_STATUS_META[value].badge} text={FLOW_STATUS_META[value].label} />
      ),
    },
    {
      title: '耗时',
      key: 'durations',
      width: 110,
      render: (_, row) => {
        const total = totalDuration(row);
        return (
          <Tooltip
            title={
              <span>
                草稿 {formatDuration(row.durations.inboundToDraftMs)} · 推送{' '}
                {formatDuration(row.durations.draftToPushMs)} · 确认{' '}
                {formatDuration(row.durations.pushToAckMs)} · 核验{' '}
                {formatDuration(row.durations.ackToVerifiedMs)}
              </span>
            }
          >
            <Text type={total && total > 3_600_000 ? 'danger' : undefined}>
              {formatDuration(total)}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 84,
      render: (_, row) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setSelectedId(row.id)}>
          查看
        </Button>
      ),
    },
  ];

  const tickerItems = useMemo(
    () => ticker.slice(0, 6).map((event) => ({ key: event.id, event })),
    [ticker],
  );

  return (
    <PageContainer
      header={{
        title: '实时服务流',
        subTitle: '草稿从生成到核验的完整生命周期；发错群与未核验会醒目标出。',
      }}
      extra={[
        <Button
          key="live"
          icon={live ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          onClick={() => setLive((value) => !value)}
        >
          {live ? '暂停实时' : '继续实时'}
        </Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card variant="borderless" className="flow-live-card">
          <div className="flow-live-head">
            <Space size={8}>
              <Badge status={live ? 'processing' : 'default'} />
              <Text strong>{live ? '实时接收中' : '实时接收已暂停'}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {live ? 'SSE 事件到达时列表自动刷新' : '暂停只影响自动刷新，手动刷新仍可用'}
              </Text>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              最近事件
            </Text>
          </div>
          <div className="flow-ticker" aria-label="最近事件">
            {tickerItems.length === 0 ? (
              <Text type="secondary">
                {isMockMode
                  ? '等待事件…（mock 模式每 2.6 秒模拟一条草稿流转）'
                  : '等待事件…（新草稿生成或核验后会实时推送）'}
              </Text>
            ) : (
              tickerItems.map(({ key, event }) => (
                <div className="flow-ticker-item" key={key}>
                  <span className="flow-ticker-time">{formatDateTime(event.at)}</span>
                  <span>{event.message}</span>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card variant="borderless">
          <Space wrap size={12} style={{ width: '100%' }}>
            <Select
              allowClear
              placeholder="全部群"
              style={{ width: 180 }}
              value={filters.groupId}
              options={groups.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => setFilters((current) => ({ ...current, groupId: value }))}
            />
            <Select
              allowClear
              placeholder="全部顾问"
              style={{ width: 140 }}
              value={filters.advisorId}
              options={advisors.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => setFilters((current) => ({ ...current, advisorId: value }))}
            />
            <Select
              allowClear
              placeholder="全部状态"
              style={{ width: 150 }}
              value={filters.status}
              options={Object.entries(FLOW_STATUS_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              onChange={(value) => setFilters((current) => ({ ...current, status: value }))}
            />
            <Select
              allowClear
              placeholder="全部风险"
              style={{ width: 120 }}
              value={filters.riskLevel}
              options={Object.entries(RISK_LABELS).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              onChange={(value) => setFilters((current) => ({ ...current, riskLevel: value }))}
            />
            <Select
              allowClear
              placeholder="全部来源"
              style={{ width: 130 }}
              value={filters.source}
              options={Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(value) => setFilters((current) => ({ ...current, source: value }))}
            />
            <DatePicker.RangePicker
              value={filters.range}
              onChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  range: value as [Dayjs, Dayjs] | null,
                }))
              }
            />
            <Button onClick={() => setFilters(EMPTY_FILTERS)}>重置筛选</Button>
            <Text type="secondary">共 {rows.length} 条</Text>
          </Space>
        </Card>

        <Table<ServiceFlowRow>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: false }}
          scroll={{ x: 1180 }}
          rowClassName={(row) =>
            row.status === 'MISROUTE_ALERT' || row.status === 'UNVERIFIED'
              ? 'flow-row-alert'
              : ''
          }
          onRow={(row) => ({
            onClick: () => setSelectedId(row.id),
            style: { cursor: 'pointer' },
          })}
        />
      </Space>

      <Drawer
        width={980}
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        destroyOnHidden
        loading={detailLoading}
        extra={
          detail && can('draft.export') && EVIDENCE_STATUSES.has(detail.draft.status) ? (
            <Button
              icon={<FilePdfOutlined />}
              loading={exporting}
              onClick={() => void exportEvidence(detail.draft.id)}
            >
              导出证据链 PDF
            </Button>
          ) : undefined
        }
        title={
          detail ? (
            <Space wrap size={10}>
              <span>{detail.draft.id}</span>
              <Tag bordered={false} color={FLOW_STATUS_META[detail.draft.status].color}>
                {FLOW_STATUS_META[detail.draft.status].label}
              </Tag>
              <Tag bordered={false} color={RISK_LABELS[detail.draft.riskLevel].color}>
                {RISK_LABELS[detail.draft.riskLevel].label}
              </Tag>
              {detail.draft.fallback && <Tag color="orange">降级草稿</Tag>}
            </Space>
          ) : (
            '草稿详情'
          )
        }
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={4}>
              <Descriptions.Item label="患者">{detail.patient.displayName}</Descriptions.Item>
              <Descriptions.Item label="群">{detail.group.name}</Descriptions.Item>
              <Descriptions.Item label="顾问">{detail.advisor.name}</Descriptions.Item>
              <Descriptions.Item label="版本">
                v{detail.draft.version}
                {detail.draft.sentVersion ? ` · 实发 v${detail.draft.sentVersion}` : ''}
              </Descriptions.Item>
            </Descriptions>

            {detail.verification?.outcome === 'misroute' && (
              <Alert
                type="error"
                showIcon
                icon={<WarningOutlined />}
                message="发错群"
                description={
                  <span>
                    草稿目标群是「{detail.group.name}」，实际发到「
                    {detail.verification.matchedGroupName ?? '未知群'}」。
                  </span>
                }
              />
            )}
            {detail.note && <Alert type="info" showIcon message={detail.note} />}

            <Tabs
              defaultActiveKey="timeline"
              items={[
                {
                  key: 'timeline',
                  label: '时间线',
                  children: (
                    <Timeline
                      items={detail.timeline.map((item) => ({
                        color: timelineColor(item.type),
                        children: (
                          <div>
                            <Space size={8} wrap>
                              <Text strong>{item.title}</Text>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {item.actor} · {formatDateTime(item.at)}
                              </Text>
                            </Space>
                            {item.detail && (
                              <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
                                {item.detail}
                              </Paragraph>
                            )}
                          </div>
                        ),
                      }))}
                    />
                  ),
                },
                {
                  key: 'body',
                  label: '草稿与实发',
                  children: detail.draft.body ? (
                    <BodyDiff detail={detail} version={version} onVersionChange={setVersion} />
                  ) : (
                    <Empty description="该消息类型暂不支持自动草稿" />
                  ),
                },
                {
                  key: 'citations',
                  label: `引用依据（${detail.citations.memories.length + detail.citations.knowledge.length}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Card size="small" title="引用的记忆">
                        {detail.citations.memories.length === 0 ? (
                          <Text type="secondary">没有引用记忆</Text>
                        ) : (
                          detail.citations.memories.map((item) => (
                            <div key={item.id} className="citation-row">
                              <Tag bordered={false} color="blue">
                                {item.category}
                              </Tag>
                              <span>{item.content}</span>
                            </div>
                          ))
                        )}
                      </Card>
                      <Card size="small" title="引用的知识">
                        {detail.citations.knowledge.length === 0 ? (
                          <Text type="secondary">没有引用知识条目</Text>
                        ) : (
                          detail.citations.knowledge.map((item) => (
                            <div key={item.id} className="citation-row">
                              <Tag bordered={false} color="green">
                                知识
                              </Tag>
                              <span>{item.title}</span>
                            </div>
                          ))
                        )}
                      </Card>
                    </Space>
                  ),
                },
                {
                  key: 'media',
                  label: `图片（${detail.media.length}）`,
                  children:
                    detail.media.length === 0 ? (
                      <Empty description="该草稿没有图片消息" />
                    ) : (
                      <Image.PreviewGroup>
                        <Space wrap size={16}>
                          {detail.media.map((item) => (
                            <div key={item.id} className="flow-media-card">
                              <Image src={item.url} width={200} height={150} />
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {mediaKindLabel(item.kind)}
                              </Text>
                            </div>
                          ))}
                        </Space>
                      </Image.PreviewGroup>
                    ),
                },
                {
                  key: 'audit',
                  label: '审计记录',
                  children: (
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={detail.audit}
                      columns={[
                        { title: '动作', dataIndex: 'action' },
                        { title: '操作人', dataIndex: 'actorName' },
                        {
                          title: '结果',
                          dataIndex: 'result',
                          render: (value: string) => (
                            <Tag color={value === 'success' ? 'green' : 'red'}>{value}</Tag>
                          ),
                        },
                        {
                          title: '时间',
                          dataIndex: 'at',
                          render: (value: number) => formatDateTime(value),
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </Space>
        ) : (
          <Empty description="正在加载详情…" />
        )}
      </Drawer>
    </PageContainer>
  );
}

function MediaCell({ kinds }: { kinds: MediaKind[] }) {
  if (kinds.length === 0) return <Text type="secondary">-</Text>;
  return (
    <Space size={4} wrap>
      {kinds.map((kind) =>
        UNSUPPORTED_KINDS.includes(kind) ? (
          <Tooltip key={kind} title={`${mediaKindLabel(kind)}消息暂不支持自动草稿`}>
            <Tag bordered={false} color="default">
              {mediaKindLabel(kind)}·不支持
            </Tag>
          </Tooltip>
        ) : (
          <Tag key={kind} bordered={false} color="orange">
            {mediaKindLabel(kind)}
          </Tag>
        ),
      )}
    </Space>
  );
}

function BodyDiff({
  detail,
  version,
  onVersionChange,
}: {
  detail: FlowDetail;
  version: number | null;
  onVersionChange: (value: number) => void;
}) {
  const current =
    detail.draft.revisions.find((item) => item.version === version) ??
    detail.draft.revisions.at(-1);
  const delivery = detail.deliveries.at(-1);
  const segments = current && delivery ? diffSegments(current.body, delivery.text) : [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="草稿版本"
        extra={
          <Select
            size="small"
            style={{ width: 200 }}
            value={current?.version}
            onChange={onVersionChange}
            options={detail.draft.revisions.map((item) => ({
              value: item.version,
              label: `v${item.version}${item.createdBy === 'staff' ? ' · 顾问改稿' : ' · Agent'}`,
            }))}
          />
        }
      >
        <Paragraph style={{ marginBottom: 8 }}>{current?.body ?? detail.draft.body}</Paragraph>
        {current?.instruction && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            改稿指令：{current.instruction}
          </Text>
        )}
      </Card>

      <Card size="small" title="实发正文">
        {delivery ? (
          <Paragraph style={{ marginBottom: 0 }}>{delivery.text}</Paragraph>
        ) : (
          <Text type="secondary">尚未发送，没有实发正文。</Text>
        )}
      </Card>

      {delivery && (
        <Card size="small" title="差异高亮（红删绿增）">
          <p className="diff-line">
            {segments.map((segment, index) =>
              segment.type === 'same' ? (
                <span key={index}>{segment.text}</span>
              ) : segment.type === 'removed' ? (
                <del key={index}>{segment.text}</del>
              ) : (
                <ins key={index}>{segment.text}</ins>
              ),
            )}
          </p>
        </Card>
      )}

      <Card size="small" title="版本演变">
        <Timeline
          items={detail.draft.revisions.map((item) => ({
            color: item.createdBy === 'staff' ? 'blue' : 'gray',
            children: (
              <div>
                <Space size={8} wrap>
                  <Text strong>v{item.version}</Text>
                  <Tag bordered={false} color={item.createdBy === 'staff' ? 'blue' : 'default'}>
                    {item.createdBy === 'staff' ? '顾问改稿' : 'Agent 生成'}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDateTime(item.createdAt)}
                  </Text>
                </Space>
                <Paragraph style={{ margin: '4px 0 0' }}>{item.body}</Paragraph>
                {item.instruction && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    指令：{item.instruction}
                  </Text>
                )}
              </div>
            ),
          }))}
        />
      </Card>
    </Space>
  );
}

function timelineColor(type: string): string {
  if (type === 'verification') return 'green';
  if (type === 'ack') return 'blue';
  if (type === 'push') return 'gray';
  if (type === 'inbound' || type === 'proactive') return 'purple';
  return 'blue';
}
