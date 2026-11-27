/**
 * PH5-02（#231）患者详情「患者端 H5」Tab：
 * 绑定状态、会话撤销、分项授权概览、邀请创建/撤销。
 * 邀请链接只在创建响应里出现一次（契约 api §12.1）；页面不缓存 code。
 */
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { isMockMode } from '../../../mock/http.ts';
import {
  createInvitation,
  getH5Binding,
  H5_CONSENT_LABELS,
  listInvitations,
  revokeH5Session,
  revokeInvitation,
  type H5BindingView,
  type H5Invitation,
  type H5Session,
} from '../../../mock/patient-h5.ts';
import { formatDateTime } from '../../../utils/format.ts';

const { Text } = Typography;

const INVITATION_STATUS_LABEL: Record<H5Invitation['status'], { label: string; color: string }> = {
  pending: { label: '待使用', color: 'blue' },
  used: { label: '已使用', color: 'green' },
  expired: { label: '已过期', color: 'default' },
  revoked: { label: '已撤销', color: 'red' },
};

/** H5 状态：直接给顾问一句人话，别让他去猜 profile_incomplete 是什么意思 */
const H5_STATUS_LABEL: Record<string, string> = {
  profile_incomplete: '档案未填完',
  data_pending: '资料待补充',
  plan_generating: '计划准备中',
  plan_active: '计划执行中',
  plan_suspended: '计划已暂停',
  service_paused: '服务已暂停',
};

const SESSION_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  active: { label: '活跃', color: 'green' },
  revoked: { label: '已撤销', color: 'red' },
  expired: { label: '已过期', color: 'default' },
};

const CONSENT_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  granted: { label: '已授权', color: 'green' },
  withdrawn: { label: '已撤回', color: 'orange' },
  never: { label: '未授权', color: 'default' },
};

interface InviteFormValues {
  phone: string;
  ttlHours?: number;
  note?: string;
}

export function H5AccessTab({
  patientId,
  canWrite,
}: {
  patientId: string;
  canWrite: boolean;
  onChanged?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [binding, setBinding] = useState<H5BindingView | null>(null);
  const [invitations, setInvitations] = useState<H5Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState<{ link: string; phoneTail: string } | null>(null);
  const [form] = Form.useForm<InviteFormValues>();
  const [showAllSessions, setShowAllSessions] = useState(false);

  const reload = (): void => {
    setLoading(true);
    Promise.all([getH5Binding(patientId), listInvitations(patientId)])
      .then(([bindingView, inviteList]) => {
        setBinding(bindingView);
        setInvitations(inviteList.items);
      })
      .catch((err: unknown) => {
        message.error(err instanceof Error ? err.message : '加载患者端信息失败');
      })
      .finally(() => setLoading(false));
  };

  useEffect(reload, [patientId, message]);

  const submitInvite = async (values: InviteFormValues): Promise<void> => {
    setCreating(true);
    try {
      const result = await createInvitation(patientId, {
        phone: values.phone,
        ...(values.ttlHours ? { ttlHours: values.ttlHours } : {}),
        ...(values.note ? { note: values.note } : {}),
      });
      setCreatedLink({ link: result.link, phoneTail: result.invitation.phoneTail });
      form.resetFields();
      reload();
      message.success('邀请已创建，链接仅本次展示');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '创建邀请失败');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin tip="正在加载患者端信息…" />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {isMockMode && (
        <Alert
          type="info"
          showIcon
          message="mock 模式：患者端数据为虚构示例，链接不可用；切换真实接口后为本租户真实状态。"
        />
      )}

      {createdLink && (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setCreatedLink(null)}
          message={`邀请已创建（尾号 ${createdLink.phoneTail}）。链接只显示这一次，复制后经服务会话发给患者：`}
          description={<Text copyable={{ text: createdLink.link }}>{createdLink.link}</Text>}
        />
      )}

      <div>
        <Typography.Title level={5}>绑定与授权</Typography.Title>
        {binding?.binding ? (
          <Space direction="vertical" size={4}>
            <Text>
              已绑定手机尾号 {binding.binding.phoneTail}（{formatDateTime(binding.binding.boundAt)}
              开通）；H5 状态：
              <Tag
                color={binding.h5Status === 'profile_incomplete' ? 'orange' : 'green'}
                style={{ marginInlineStart: 4 }}
              >
                {H5_STATUS_LABEL[binding.h5Status] ?? binding.h5Status}
              </Tag>
              {binding.h5Status === 'profile_incomplete' &&
                (binding.missingFields?.length ?? 0) > 0 && (
                  <Text type="secondary" style={{ marginInlineStart: 6 }}>
                    缺：{binding.missingFields!.join('、')}
                  </Text>
                )}
            </Text>
            <Space size={[8, 8]} wrap>
              {Object.entries(H5_CONSENT_LABELS).map(([scope, label]) => {
                const status = binding.consents[scope] ?? 'never';
                const meta = CONSENT_STATUS_LABEL[status]!;
                return (
                  <Tag key={scope} color={meta.color}>
                    {label}：{meta.label}
                  </Tag>
                );
              })}
            </Space>
          </Space>
        ) : (
          <Text type="secondary">患者尚未开通 H5：创建邀请后由患者本人兑换绑定。</Text>
        )}
      </div>

      {binding && binding.sessions.length > 0 && (
        <Table<H5Session>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={
            showAllSessions
              ? [...binding.sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
              : [...binding.sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 5)
          }
          footer={
            binding.sessions.length > 5
              ? () => (
                  <Button type="link" size="small" onClick={() => setShowAllSessions((v) => !v)}>
                    {showAllSessions
                      ? '只看最近 5 条'
                      : `更早的 ${binding.sessions.length - 5} 条（已过期/已撤销的居多）`}
                  </Button>
                )
              : undefined
          }
          columns={[
            { title: '设备', dataIndex: 'userAgentSummary', render: (v) => v ?? '未知' },
            {
              title: '登录方式',
              dataIndex: 'authMethod',
              render: (v) => (v === 'invite_sms' ? '邀请兑换' : '手机号登录'),
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (v: string) => {
                const meta = SESSION_STATUS_LABEL[v] ?? { label: v, color: 'default' };
                return <Tag color={meta.color}>{meta.label}</Tag>;
              },
            },
            { title: '最近活跃', dataIndex: 'lastSeenAt', render: (v) => formatDateTime(v) },
            {
              title: '操作',
              render: (_: unknown, record) =>
                canWrite && record.status === 'active' ? (
                  <Popconfirm
                    title="撤销该会话？"
                    description="患者当前登录立即失效，需重新验证身份。"
                    onConfirm={async () => {
                      try {
                        await revokeH5Session(patientId, record.id);
                        message.success('会话已撤销');
                        reload();
                      } catch (err: unknown) {
                        message.error(err instanceof Error ? err.message : '撤销失败');
                      }
                    }}
                  >
                    <Button size="small" danger>
                      撤销会话
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
        />
      )}

      <div>
        <Typography.Title level={5}>邀请</Typography.Title>
        {canWrite && (
          <Form form={form} layout="inline" onFinish={(values) => void submitInvite(values)}>
            <Form.Item
              name="phone"
              rules={[
                { required: true, message: '填写患者手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确' },
              ]}
            >
              <Input placeholder="患者手机号" inputMode="numeric" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="ttlHours" initialValue={24}>
              <InputNumber min={1} max={72} addonAfter="小时" style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="note">
              <Input placeholder="备注（可选）" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={creating}>
                创建邀请
              </Button>
            </Form.Item>
          </Form>
        )}
        <List
          size="small"
          style={{ marginTop: 12 }}
          dataSource={invitations}
          locale={{ emptyText: '暂无邀请记录' }}
          renderItem={(item) => {
            const meta = INVITATION_STATUS_LABEL[item.status]!;
            return (
              <List.Item
                actions={
                  canWrite && item.status === 'pending'
                    ? [
                        <Popconfirm
                          key="revoke"
                          title="撤销邀请？"
                          onConfirm={async () => {
                            try {
                              await revokeInvitation(item.id);
                              message.success('邀请已撤销');
                              reload();
                            } catch (err: unknown) {
                              message.error(err instanceof Error ? err.message : '撤销失败');
                            }
                          }}
                        >
                          <Button size="small" danger>
                            撤销
                          </Button>
                        </Popconfirm>,
                      ]
                    : undefined
                }
              >
                <Space size={12}>
                  <Tag color={meta.color}>{meta.label}</Tag>
                  <Text>尾号 {item.phoneTail}</Text>
                  <Text type="secondary">
                    创建于 {formatDateTime(item.createdAt)} · 过期于 {formatDateTime(item.expiresAt)}
                  </Text>
                  {item.note && <Text type="secondary">备注：{item.note}</Text>}
                </Space>
              </List.Item>
            );
          }}
        />
      </div>
    </Space>
  );
}
