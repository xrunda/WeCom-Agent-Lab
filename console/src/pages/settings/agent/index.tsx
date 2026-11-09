import { RobotOutlined, SaveOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, App, Avatar, Button, Card, Form, Input, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext.tsx';
import { PATIENT_TERMS, type PatientTerm } from '../../../types.ts';
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
  const canWrite = can('setting.write');
  const [saving, setSaving] = useState(false);
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

  const agentName = Form.useWatch('agentName', form) ?? tenant?.agentName ?? 'Agent';
  const agentAvatar = Form.useWatch('agentAvatar', form) ?? tenant?.agentAvatar ?? null;
  const patientTerm = Form.useWatch('patientTerm', form) ?? tenant?.patientTerm ?? '患者';

  const save = async (values: AgentFormValues) => {
    setSaving(true);
    try {
      await updateTenant({
        agentName: values.agentName.trim(),
        agentAvatar: values.agentAvatar?.trim() || null,
        patientTerm: values.patientTerm,
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
              message="只读账号"
              description="当前角色可以查看设定，但不能修改。"
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
              rules={[{ required: true, message: '请选择称谓' }]}
              extra="影响菜单与页面文案，例如「患者 Agent」「客户 Agent」。"
            >
              <Select options={PATIENT_TERMS.map((term) => ({ value: term, label: term }))} />
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
            <Text type="secondary">系统提示词包含：名字、称谓、语气说明，以及不诊断、不调药、不承诺疗效、急症引导就医四条红线。</Text>
          </Space>
        </Card>
      </div>
    </PageContainer>
  );
}
