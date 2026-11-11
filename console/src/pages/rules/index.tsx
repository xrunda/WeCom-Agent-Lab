import { LockOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import {
  createRiskRule,
  deleteRiskRule,
  listRiskRules,
  updateRiskRule,
} from '../../mock/rules.ts';
import type { RiskAction, RiskLevel, RiskRule } from '../../types.ts';
import '../wp-l.css';
import './rules.css';

const { Text } = Typography;

const RISK_LABELS: Record<RiskLevel, { label: string; color: string }> = {
  high: { label: '高风险', color: 'red' },
  medium: { label: '中风险', color: 'orange' },
  low: { label: '低风险', color: 'default' },
};

const ACTION_LABELS: Record<RiskAction, string> = {
  flag: '标记风险',
  escalate: '升级顾问',
};

interface RuleFormValues {
  name: string;
  keywords: string[];
  riskLevel: RiskLevel;
  action: RiskAction;
  enabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function RulesPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const canWrite = can('tenant.write');

  const [rules, setRules] = useState<RiskRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RiskRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<RuleFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listRiskRules();
      setRules(result.items);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const redlines = rules.filter((rule) => rule.kind === 'redline');
  const keywords = rules.filter((rule) => rule.kind === 'keyword');

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      name: '',
      keywords: [],
      riskLevel: 'high',
      action: 'flag',
      enabled: true,
    });
    setModalOpen(true);
  };

  const openEdit = (rule: RiskRule) => {
    setEditing(rule);
    form.setFieldsValue({
      name: rule.name,
      keywords: rule.keywords,
      riskLevel: rule.riskLevel,
      action: rule.action,
      enabled: rule.enabled,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await updateRiskRule(editing.id, values);
        message.success('规则已保存，下一轮对话生效');
      } else {
        await createRiskRule(values);
        message.success('关键词规则已新增，下一轮对话生效');
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: RiskRule, enabled: boolean) => {
    setSwitchingId(rule.id);
    try {
      const next = await updateRiskRule(rule.id, { enabled });
      setRules((current) => current.map((item) => (item.id === rule.id ? next : item)));
      message.success(enabled ? '规则已启用' : '规则已停用');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSwitchingId(null);
    }
  };

  const remove = async (rule: RiskRule) => {
    try {
      await deleteRiskRule(rule.id);
      message.success('规则已删除');
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const redlineColumns: ColumnsType<RiskRule> = [
    {
      title: '红线规则',
      dataIndex: 'name',
      key: 'name',
      render: (value: string) => (
        <span className="zb-inline">
          <LockOutlined className="rules-lock" />
          <Text strong>{value}</Text>
        </span>
      ),
    },
    {
      title: '触发词',
      dataIndex: 'keywords',
      key: 'keywords',
      render: (values: string[]) => (
        <Space size={[4, 4]} wrap>
          {values.map((keyword) => (
            <Tag key={keyword} bordered={false}>
              {keyword}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 110,
      render: (value: RiskAction) => <Tag color={value === 'escalate' ? 'orange' : 'default'}>{ACTION_LABELS[value]}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (value: boolean) => (value ? <Tag color="green">内置启用</Tag> : <Tag>停用</Tag>),
    },
  ];

  const keywordColumns: ColumnsType<RiskRule> = [
    {
      title: '规则名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (value: string) => <Text strong>{value}</Text>,
    },
    {
      title: '关键词',
      dataIndex: 'keywords',
      key: 'keywords',
      render: (values: string[]) => (
        <Space size={[4, 4]} wrap>
          {values.map((keyword) => (
            <Tag key={keyword} color="blue" bordered={false}>
              {keyword}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '风险',
      dataIndex: 'riskLevel',
      key: 'riskLevel',
      width: 92,
      render: (value: RiskLevel) => <Tag color={RISK_LABELS[value].color}>{RISK_LABELS[value].label}</Tag>,
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 110,
      render: (value: RiskAction) => <Tag color={value === 'escalate' ? 'orange' : 'default'}>{ACTION_LABELS[value]}</Tag>,
    },
    {
      title: '命中',
      dataIndex: 'hitCount',
      key: 'hitCount',
      width: 78,
      align: 'right',
      render: (value: number) => <span className="rules-hits">{value} 次</span>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 86,
      render: (_, rule) => (
        <Switch
          size="small"
          checked={rule.enabled}
          disabled={!canWrite}
          loading={switchingId === rule.id}
          onChange={(checked) => void toggle(rule, checked)}
        />
      ),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 112,
            render: (_: unknown, rule: RiskRule) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(rule)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除这条关键词规则？"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(rule)}
                >
                  <Button type="link" size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          } as ColumnsType<RiskRule>[number],
        ]
      : []),
  ];

  return (
    <PageContainer
      header={{
        title: '风险规则',
        subTitle: '健康红线由平台内置只读；关键词规则真实生效，命中后标记风险，由顾问决定发不发。',
        extra: canWrite
          ? [
              <Button key="create" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增关键词规则
              </Button>,
            ]
          : undefined,
      }}
    >
      <div className="rules-stack">
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="红线规则由 zhiban-guard 在草稿产出后校验，命中即标高风险，不阻断推送。"
          description="不诊断、不调药、不承诺疗效、急症只引导就医。内置规则由平台维护，机构不能修改或删除。"
        />

        <Card className="zb-card" variant="borderless" title="内置红线" extra={<Tag bordered={false}>只读</Tag>}>
          <Table<RiskRule>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={redlineColumns}
            dataSource={redlines}
            pagination={false}
            scroll={{ x: 620 }}
          />
        </Card>

        <Card
          className="zb-card"
          variant="borderless"
          title="关键词规则"
          extra={
            <Space>
              <Text type="secondary">命中后标记风险等级</Text>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
                刷新
              </Button>
            </Space>
          }
        >
          <Table<RiskRule>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={keywordColumns}
            dataSource={keywords}
            pagination={false}
            scroll={{ x: 820 }}
            locale={{ emptyText: '还没有关键词规则' }}
          />
        </Card>
      </div>

      <Modal
        title={editing ? '编辑关键词规则' : '新增关键词规则'}
        open={modalOpen}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        destroyOnHidden
      >
        <Form<RuleFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          initialValues={{ riskLevel: 'high', action: 'flag', enabled: true }}
        >
          <Form.Item label="规则名称" name="name" rules={[{ required: true, message: '请填写规则名称' }]}>
            <Input maxLength={40} showCount placeholder="例如：用药-停药" />
          </Form.Item>
          <Form.Item
            label="关键词"
            name="keywords"
            rules={[{ required: true, message: '至少填写一个关键词' }]}
            extra="支持逗号或回车分隔；命中任意一个即触发。"
          >
            <Select
              mode="tags"
              open={false}
              tokenSeparators={[',', '，', ' ']}
              placeholder="输入关键词后回车，例如：停药"
              suffixIcon={null}
            />
          </Form.Item>
          <div className="rules-form-row">
            <Form.Item label="风险等级" name="riskLevel" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'high', label: '高风险' },
                  { value: 'medium', label: '中风险' },
                  { value: 'low', label: '低风险' },
                ]}
              />
            </Form.Item>
            <Form.Item label="命中动作" name="action" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'flag', label: '标记风险' },
                  { value: 'escalate', label: '升级顾问' },
                ]}
              />
            </Form.Item>
          </div>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
