import { CheckCircleOutlined, RobotOutlined, SaveOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  AutoComplete,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext.tsx';
import { ENABLED_CAPABILITIES } from '../../../capabilities.ts';
import { getAgentPrompt } from '../../../mock/api.ts';
import {
  PATIENT_TERM_MAX_LENGTH,
  PATIENT_TERMS,
  type PatientTerm,
} from '../../../types.ts';
import { formatDateTime } from '../../../utils/format.ts';
import '../settings.css';
import '../../wp-l.css';

const { Paragraph, Text } = Typography;

interface AgentFormValues {
  agentName: string;
  agentAvatar: string | null;
  patientTerm: PatientTerm;
  tone: string;
}

export default function AgentSettingsPage() {
  const { tenant, updateTenant, can } = useAuth();
  const { message } = App.useApp();
  const canWrite = can('tenant.write');
  const [saving, setSaving] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [promptLoading, setPromptLoading] = useState(true);
  const [form] = Form.useForm<AgentFormValues>();

  useEffect(() => {
    if (!tenant) return;
    form.setFieldsValue({
      agentName: tenant.agentName,
      agentAvatar: tenant.agentAvatar,
      patientTerm: tenant.patientTerm,
      tone: tenant.tone,
    });
  }, [form, tenant]);

  // 展示当前实际注入的提示词；保存设定后 tenant.updatedAt 变化，重新取一版
  useEffect(() => {
    let alive = true;
    setPromptLoading(true);
    getAgentPrompt()
      .then((value) => {
        if (alive) setPrompt(value);
      })
      .catch(() => {
        // 患者 Agent 未运行时读不到；页面其他部分仍可用
        if (alive) setPrompt(null);
      })
      .finally(() => {
        if (alive) setPromptLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tenant?.updatedAt]);

  const agentName = Form.useWatch('agentName', form) ?? tenant?.agentName ?? 'Agent';
  const agentAvatar = Form.useWatch('agentAvatar', form) ?? tenant?.agentAvatar ?? null;
  const patientTerm = Form.useWatch('patientTerm', form) ?? tenant?.patientTerm ?? '患者';

  const save = async (values: AgentFormValues) => {
    setSaving(true);
    try {
      await updateTenant({
        agentName: values.agentName.trim(),
        agentAvatar: values.agentAvatar?.trim() || null,
        patientTerm: values.patientTerm.trim(),
        tone: values.tone.trim(),
      });
      message.success('已保存，下一条草稿与沙盒中的名字立即同步');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer
      header={{
        title: 'Agent 设定',
        subTitle: `Agent 名字、${patientTerm}称谓、头像与语气说明；保存后注入系统提示词。`,
        extra: tenant ? [<Text key="updated" type="secondary">最近更新 {formatDateTime(tenant.updatedAt)}</Text>] : undefined,
      }}
    >
      <div className="settings-grid-2">
        <Card className="zb-card" variant="borderless" title="基础设定">
          {!canWrite ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="当前角色不能修改 Agent 设定"
              description="名字、称谓与语气会写进所有草稿和沙盒回复，只有机构管理员可以修改；其他角色可以查看。"
            />
          ) : null}
          <Form<AgentFormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            disabled={!canWrite}
            onFinish={(values) => void save(values)}
          >
            <Form.Item
              label="Agent 名字"
              name="agentName"
              rules={[
                { required: true, message: '请填写 Agent 名字' },
                { max: 12, message: '名字不超过 12 个字' },
              ]}
              extra="会出现在草稿、沙盒与审计记录中。"
            >
              <Input maxLength={12} showCount placeholder="例如：小安" />
            </Form.Item>

            <Form.Item
              label="头像 URL"
              name="agentAvatar"
              extra="演示环境可留空；接入真实上传接口后替换为上传结果。"
            >
              <Input allowClear placeholder="https://…（可留空）" />
            </Form.Item>

            <Form.Item
              label={`${patientTerm}称谓`}
              name="patientTerm"
              rules={[
                { required: true, whitespace: true, message: '请填写称谓' },
                {
                  max: PATIENT_TERM_MAX_LENGTH,
                  message: `称谓不超过 ${PATIENT_TERM_MAX_LENGTH} 个字`,
                },
              ]}
              extra="影响菜单、页面文案与 Agent 提示词。可直接输入自定义叫法，例如「亲人」「家人」。"
            >
              <AutoComplete
                options={PATIENT_TERMS.map((term) => ({ value: term, label: term }))}
                placeholder="例如：患者、客户、会员、亲人、家人"
                maxLength={PATIENT_TERM_MAX_LENGTH}
                filterOption={(input, option) =>
                  String(option?.value ?? '').includes(input.trim())
                }
              />
            </Form.Item>

            <Form.Item
              label="语气说明"
              name="tone"
              rules={[{ required: true, message: '请填写语气说明' }]}
              extra="注入系统提示词；建议写清称呼、长度与先共情后建议的规则。"
            >
              <Input.TextArea rows={5} maxLength={220} showCount placeholder="例如：亲切、专业、简洁，单条不超过 150 字。" />
            </Form.Item>

            <div className="settings-form-actions">
              <Text type="secondary">保存后立即生效；无需重启。</Text>
              {canWrite ? (
                <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
                  保存设定
                </Button>
              ) : null}
            </div>
          </Form>
        </Card>

        <Card className="agent-preview-card" variant="borderless" title="实时预览">
          <div className="agent-preview-head">
            <Avatar size={62} src={agentAvatar || undefined} style={{ background: '#0f766e', fontSize: 24 }}>
              {agentName.slice(0, 1)}
            </Avatar>
            <div className="agent-preview-name">
              <strong>{agentName || '未命名 Agent'}</strong>
              <Text type="secondary">
                <RobotOutlined /> {tenant?.name ?? '机构'} · {patientTerm}
              </Text>
            </div>
          </div>
          <div className="agent-preview-bubble">
            您好，我是{agentName || '健康助手'}，负责陪伴您的日常健康管理。饮食、作息上有想聊的，
            随时在这里说，我会帮您记下来。
          </div>
          <Paragraph className="agent-preview-foot">
            示例回复仅用于预览文案与称谓；真实回复会带上机构知识、记忆与红线约束。
          </Paragraph>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Text type="secondary">
              系统提示词包含：名字、称谓、语气说明、说话方式（像真人顾问、60–150 字、不分点），以及健康红线和工具约定。
            </Text>
          </Space>
        </Card>
      </div>

      <Card
        className="zb-card"
        variant="borderless"
        title="系统提示词"
        extra={<Text type="secondary">只读 · 每轮对话注入</Text>}
        style={{ marginTop: 16 }}
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          由上面的名字、称谓、语气说明和平台统一规则拼成。说话方式与红线由平台维护，
          机构不能在这里改；修改「语气说明」保存后，下一轮草稿立即生效。
        </Paragraph>
        {promptLoading ? (
          <Text type="secondary">正在读取当前提示词…</Text>
        ) : prompt ? (
          <pre className="agent-prompt">{prompt}</pre>
        ) : (
          <Text type="secondary">
            暂时读不到系统提示词（患者 Agent 未运行）。上面的设定仍会保存并在 Agent 恢复后生效。
          </Text>
        )}
      </Card>

      <Card
        className="zb-card"
        variant="borderless"
        title="已启用能力"
        extra={<Text type="secondary">由平台统一安装</Text>}
        style={{ marginTop: 16 }}
      >
        <Space size={[8, 8]} wrap>
          {ENABLED_CAPABILITIES.map((name) => (
            <Tag key={name} bordered={false} color="green" icon={<CheckCircleOutlined />}>
              {name}
            </Tag>
          ))}
        </Space>
        <Paragraph type="secondary" style={{ margin: '12px 0 0' }}>
          能力随服务包以插件形式启用，机构无需安装或升级；需要新增能力时走开通申请。
        </Paragraph>
      </Card>
    </PageContainer>
  );
}
