import { DownloadOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext.tsx';
import { exportAuditCsv, listAudit } from '../../../mock/settings.ts';
import type { AuditEvent, AuditFilters } from '../../../types.ts';
import { formatDateTime } from '../../../utils/format.ts';
import '../settings.css';
import '../../wp-l.css';

const { Paragraph, Text } = Typography;

const ACTION_LABELS: Record<string, string> = {
  'auth.login': '登录',
  'draft.enqueue': '草稿入队',
  'draft.push': '草稿推送',
  'draft.ack': '顾问确认',
  'draft.verify': '回读核验',
  'draft.rewrite': '顾问改稿',
  'memory.create': '新增记忆',
  'memory.update': '更新记忆',
  'alert.create': '新建告警',
  'alert.resolve': '处理告警',
  'advisor.pause': '暂停顾问',
  'advisor.restore': '恢复顾问',
  'knowledge.create': '新增知识',
  'knowledge.update': '更新知识',
  'knowledge.delete': '删除知识',
  'rule.create': '新增规则',
  'rule.update': '更新规则',
  'rule.delete': '删除规则',
  'setting.update': '更新设置',
  'account.create': '新建账号',
  'account.update': '更新账号',
  'account.delete': '删除账号',
  'account.reset_password': '重置密码',
  'evidence.export': '导出证据',
  'onboarding.submit': '提交开通申请',
  'audit.export': '导出审计日志',
  'sandbox.message': '沙盒消息',
};

const ACTOR_LABELS: Record<AuditEvent['actorType'], string> = {
  account: '账号',
  system: '系统',
  agent: 'Agent',
};

const ACTOR_COLORS: Record<AuditEvent['actorType'], string> = {
  account: 'blue',
  system: 'default',
  agent: 'purple',
};

interface AuditFormValues {
  actorType?: AuditEvent['actorType'];
  action?: string;
  result?: AuditEvent['result'];
  range?: [Dayjs | null, Dayjs | null] | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function AuditSettingsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const canExport = can('export');

  const [items, setItems] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  const [form] = Form.useForm<AuditFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAudit({ ...filters, page, pageSize });
      setItems(result.items);
      setTotal(result.total);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filters, message, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilters = (values: AuditFormValues) => {
    const from = values.range?.[0]?.startOf('day').valueOf();
    const to = values.range?.[1]?.endOf('day').valueOf();
    setFilters({
      actorType: values.actorType,
      action: values.action,
      result: values.result,
      from,
      to,
    });
    setPage(1);
  };

  const resetFilters = () => {
    form.resetFields();
    setFilters({});
    setPage(1);
  };

  const download = async () => {
    setExporting(true);
    try {
      const csv = await exportAuditCsv(filters);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = `audit-${stamp}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      message.success('已导出 CSV（带 BOM，Excel 打开中文正常）');
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<AuditEvent> = [
    {
      title: '时间',
      dataIndex: 'at',
      key: 'at',
      width: 158,
      render: (value: number) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '操作者',
      key: 'actor',
      width: 160,
      render: (_, event) => (
        <Space size={6}>
          <Text>{event.actorName}</Text>
          <Tag color={ACTOR_COLORS[event.actorType]} bordered={false}>
            {ACTOR_LABELS[event.actorType]}
          </Tag>
        </Space>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 170,
      render: (value: string) => (
        <div className="audit-action-cell">
          <Text>{ACTION_LABELS[value] ?? value}</Text>
          <div>
            <Text type="secondary" className="audit-table-action">
              {value}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: '对象',
      key: 'target',
      width: 190,
      render: (_, event) => (
        <Text type="secondary" className="audit-table-action">
          {event.targetType}
          {event.targetId ? ` / ${event.targetId}` : ''}
        </Text>
      ),
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      width: 86,
      render: (value: AuditEvent['result']) =>
        value === 'success' ? (
          <Tag color="green" bordered={false}>
            成功
          </Tag>
        ) : (
          <Tag color="red" bordered={false}>
            失败
          </Tag>
        ),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      key: 'ip',
      width: 120,
      render: (value: string) => <Text type="secondary" className="audit-table-action">{value}</Text>,
    },
    {
      title: '沙盒',
      dataIndex: 'sandbox',
      key: 'sandbox',
      width: 76,
      render: (value: boolean) =>
        value ? (
          <Tag color="purple" bordered={false}>
            沙盒
          </Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 70,
      render: (_, event) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setDetail(event)}>
          查看
        </Button>
      ),
    },
  ];

  return (
    <PageContainer
      header={{
        title: '审计日志',
        subTitle: '操作与状态变化记录，可筛选、导出 CSV；detail 已脱敏，不包含消息正文。',
        extra: [
          <Text key="count" type="secondary">
            共 {total} 条
          </Text>,
          canExport ? (
            <Button
              key="export"
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void download()}
            >
              导出 CSV
            </Button>
          ) : null,
        ],
      }}
    >
      <div className="settings-stack">
        <Card className="zb-card" variant="borderless">
          <Form<AuditFormValues>
            form={form}
            layout="inline"
            className="audit-filter-form"
            onFinish={applyFilters}
          >
            <Form.Item name="actorType" label="操作者">
              <Select
                allowClear
                style={{ width: 120 }}
                placeholder="全部"
                options={[
                  { value: 'account', label: '账号' },
                  { value: 'system', label: '系统' },
                  { value: 'agent', label: 'Agent' },
                ]}
              />
            </Form.Item>
            <Form.Item name="action" label="动作">
              <Select
                allowClear
                showSearch
                style={{ width: 180 }}
                placeholder="全部"
                optionFilterProp="label"
                options={Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </Form.Item>
            <Form.Item name="result" label="结果">
              <Select
                allowClear
                style={{ width: 110 }}
                placeholder="全部"
                options={[
                  { value: 'success', label: '成功' },
                  { value: 'failure', label: '失败' },
                ]}
              />
            </Form.Item>
            <Form.Item name="range" label="时间">
              <DatePicker.RangePicker allowClear />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit">
                  查询
                </Button>
                <Button onClick={resetFilters}>重置</Button>
                <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                  刷新
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>

        <Card className="zb-card" variant="borderless">
          <Table<AuditEvent>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={items}
            scroll={{ x: 1080 }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (count) => `共 ${count} 条`,
              onChange: (nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
              },
            }}
            locale={{ emptyText: '没有匹配的审计记录' }}
          />
        </Card>
      </div>

      <Drawer title="审计详情" width={460} open={Boolean(detail)} onClose={() => setDetail(null)}>
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="时间">{formatDateTime(detail.at)}</Descriptions.Item>
              <Descriptions.Item label="操作者">
                {detail.actorName}（{ACTOR_LABELS[detail.actorType]}）
              </Descriptions.Item>
              <Descriptions.Item label="动作">
                {ACTION_LABELS[detail.action] ?? detail.action}
                <Text type="secondary" className="audit-table-action"> · {detail.action}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="对象">
                {detail.targetType}
                {detail.targetId ? ` / ${detail.targetId}` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="结果">
                {detail.result === 'success' ? '成功' : '失败'}
                {detail.errorCode ? `（${detail.errorCode}）` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="IP">{detail.ip}</Descriptions.Item>
              <Descriptions.Item label="沙盒">{detail.sandbox ? '是' : '否'}</Descriptions.Item>
            </Descriptions>
            <div>
              <Text strong>附加详情</Text>
              <Paragraph type="secondary" style={{ margin: '4px 0 8px', fontSize: 12 }}>
                detail 已经脱敏；不包含消息正文、密码或密钥。
              </Paragraph>
              {detail.detail ? (
                <pre className="audit-detail-pre">{JSON.stringify(detail.detail, null, 2)}</pre>
              ) : (
                <Text type="secondary">无附加详情</Text>
              )}
            </div>
          </Space>
        ) : null}
      </Drawer>
    </PageContainer>
  );
}
