import {
  CheckCircleFilled,
  DeleteOutlined,
  KeyOutlined,
  PlusOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../../auth/AuthContext.tsx';
import { getWecomBindUrl, isMockMode } from '../../../mock/api.ts';
import {
  createAccount,
  deleteAccount,
  getPermissionMatrix,
  listAccounts,
  resetAccountPassword,
  updateAccount,
} from '../../../mock/settings.ts';
import type { Account, PermissionMatrix, Role } from '../../../types.ts';
import { formatDateTime } from '../../../utils/format.ts';
import { PERMISSION_ROWS, ROLE_META, roleHas } from '../../../utils/permissions.ts';
import type { PermissionRow } from '../../../utils/permissions.ts';
import '../settings.css';
import '../../wp-l.css';

const { Text } = Typography;

interface CreateFormValues {
  username: string;
  displayName: string;
  role: Role;
  password: string;
  wecomUserId?: string;
}

interface ResetFormValues {
  newPassword: string;
  confirmPassword: string;
}

interface WecomFormValues {
  wecomUserId?: string;
}

interface H5FormValues {
  h5Permissions?: string[];
}

/**
 * 患者端 H5 能力：与角色权限矩阵分开，管理员也不自动拥有。
 * 文案要说清「能做什么」，否则管理员只能看权限名猜。
 */
const H5_CAPABILITY_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'h5.plan.review', label: '方案审核', hint: '发布、退回、暂停患者的健康计划' },
  { value: 'h5.content.edit', label: '内容编辑', hint: '新建与修改食养内容' },
  { value: 'h5.content.review', label: '内容审核', hint: '审核发布或下架食养内容' },
];

const H5_CAPABILITY_LABEL: Record<string, string> = Object.fromEntries(
  H5_CAPABILITY_OPTIONS.map((item) => [item.value, item.label]),
);

/** 与后端一致：1–64 位字母、数字与 `._@-` */
const WECOM_USERID_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** 扫码绑定回调结果（`/settings/accounts?wecom=`），文案要能指导下一步动作 */
const WECOM_BIND_RESULTS: Record<
  string,
  { type: 'success' | 'warning' | 'error'; text: string }
> = {
  bound: { type: 'success', text: '企微身份已绑定，该成员可以直接扫码登录' },
  conflict: { type: 'error', text: '这个企微身份已绑定在其他账号上，请先解绑旧账号再试' },
  scope: {
    type: 'error',
    text: '扫码的企微账号不在「知伴顾问助手」的可见范围内，请先在企微后台把它加进来',
  },
  expired: { type: 'warning', text: '绑定链接已失效，请重新点击「扫码绑定我的企微身份」' },
  unavailable: {
    type: 'error',
    text: '企业微信扫码绑定暂时不可用，请稍后重试，或手动填写 userid',
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function AccountsSettingsPage() {
  const { can, session } = useAuth();
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bindPending, setBindPending] = useState(false);
  // 后端 GET /accounts 同样要求 account.write，所以「能看」与「能管」是同一权限
  const canWrite = can('account.write');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<Role | undefined>();
  const [statusFilter, setStatusFilter] = useState<Account['status'] | undefined>();
  const [modal, setModal] = useState<'create' | 'reset' | 'wecom' | 'h5' | null>(null);
  const [target, setTarget] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [resetForm] = Form.useForm<ResetFormValues>();
  const [wecomForm] = Form.useForm<WecomFormValues>();
  const [h5Form] = Form.useForm<H5FormValues>();

  const load = useCallback(async () => {
    if (!canWrite) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [accountResult, matrixResult] = await Promise.all([
        listAccounts({ role: roleFilter, status: statusFilter }),
        getPermissionMatrix(),
      ]);
      setAccounts(accountResult.items);
      setMatrix(matrixResult);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [canWrite, message, roleFilter, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // 扫码绑定回调：先提示结果，再把 `wecom` 参数从地址栏清掉，刷新后会重复提示
  useEffect(() => {
    const wecom = searchParams.get('wecom');
    if (!wecom) return;
    const result = WECOM_BIND_RESULTS[wecom];
    if (result) {
      if (result.type === 'success') message.success(result.text);
      else if (result.type === 'warning') message.warning(result.text);
      else message.error(result.text);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('wecom');
    setSearchParams(next, { replace: true });
    if (wecom === 'bound') void load();
  }, [searchParams, setSearchParams, message, load]);

  const openCreate = () => {
    createForm.setFieldsValue({
      username: '',
      displayName: '',
      role: 'supervisor',
      password: '',
      wecomUserId: '',
    });
    setModal('create');
  };

  const openWecom = (account: Account) => {
    setTarget(account);
    wecomForm.setFieldsValue({ wecomUserId: account.wecomUserId ?? '' });
    setModal('wecom');
  };

  const openH5 = (account: Account) => {
    setTarget(account);
    h5Form.setFieldsValue({ h5Permissions: account.h5Permissions ?? [] });
    setModal('h5');
  };

  const submitH5 = async () => {
    if (!target) return;
    const values = await h5Form.validateFields();
    setSaving(true);
    try {
      const updated = await updateAccount(target.id, {
        h5Permissions: values.h5Permissions ?? [],
      });
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      message.success(
        (values.h5Permissions ?? []).length === 0
          ? '已收回全部 H5 能力'
          : 'H5 能力已更新，对方下次请求即生效',
      );
      setModal(null);
      setTarget(null);
      h5Form.resetFields();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const openReset = (account: Account) => {
    setTarget(account);
    resetForm.resetFields();
    setModal('reset');
  };

  const submitCreate = async () => {
    const values = await createForm.validateFields();
    setSaving(true);
    try {
      await createAccount({ ...values, wecomUserId: values.wecomUserId?.trim() || undefined });
      message.success('账号已创建，请通过安全渠道把初始密码交给本人');
      setModal(null);
      setTarget(null);
      createForm.resetFields();
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const submitReset = async () => {
    if (!target) return;
    const values = await resetForm.validateFields();
    setSaving(true);
    try {
      await resetAccountPassword(target.id, values.newPassword);
      message.success('密码已重置，请通过安全渠道告知账号本人');
      setModal(null);
      setTarget(null);
      resetForm.resetFields();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const submitWecom = async () => {
    if (!target) return;
    const values = await wecomForm.validateFields();
    const next = values.wecomUserId?.trim() ?? '';
    setSaving(true);
    try {
      const updated = await updateAccount(target.id, { wecomUserId: next === '' ? null : next });
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      message.success(next === '' ? '已解绑企微成员' : '已绑定企微成员，对方可直接扫码登录');
      setModal(null);
      setTarget(null);
      wecomForm.resetFields();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  // 扫码绑定：拿一次性扫码 URL 后整页跳转，扫码成功由回调带回 ?wecom=bound
  const startBind = async () => {
    setBindPending(true);
    try {
      const url = await getWecomBindUrl();
      if (!url) {
        message.error('企业微信扫码绑定暂不可用，请手动填写 userid');
        return;
      }
      window.location.assign(url);
    } finally {
      setBindPending(false);
    }
  };

  const toggleStatus = async (account: Account, enabled: boolean) => {
    setSwitchingId(account.id);
    try {
      const next = await updateAccount(account.id, {
        status: enabled ? 'active' : 'disabled',
      });
      setAccounts((current) => current.map((item) => (item.id === account.id ? next : item)));
      message.success(enabled ? '账号已启用' : '账号已停用');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSwitchingId(null);
    }
  };

  const remove = async (account: Account) => {
    try {
      await deleteAccount(account.id);
      message.success('账号已删除');
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  if (!canWrite) {
    return (
      <PageContainer header={{ title: '账号与角色' }}>
        <Result
          status="403"
          title="无权查看账号与角色"
          subTitle="账号管理仅对机构管理员开放；当前角色看不到新建、重置密码等写操作。"
        />
      </PageContainer>
    );
  }

  const isSelf = (account: Account) => session?.account.id === account.id;
  const selfAccount = accounts.find((account) => isSelf(account));
  // 扫码绑定绑定的是扫码人自己的身份，且 mock 模式没有企微后端
  const canScanBind = Boolean(target && isSelf(target) && !isMockMode);

  const columns: ColumnsType<Account> = [
    {
      title: '账号',
      key: 'account',
      width: 220,
      render: (_, account) => (
        <div className="account-cell">
          <Text strong>{account.username}</Text>
          {isSelf(account) ? (
            <Tag className="account-self-tag" color="cyan" bordered={false}>
              当前账号
            </Tag>
          ) : null}
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {account.displayName}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 120,
      render: (value: Role) => <Tag color={ROLE_META[value].color}>{ROLE_META[value].label}</Tag>,
    },
    {
      title: 'H5 能力',
      dataIndex: 'h5Permissions',
      key: 'h5Permissions',
      width: 150,
      render: (value?: string[]) =>
        value && value.length > 0 ? (
          <Tooltip title={value.map((item) => H5_CAPABILITY_LABEL[item] ?? item).join('、')}>
            <Tag color="green">{value.length} 项</Tag>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            未授予
          </Text>
        ),
    },
    {
      title: '企微成员',
      dataIndex: 'wecomUserId',
      key: 'wecomUserId',
      width: 170,
      render: (value?: string) =>
        value ? <Text code>{value}</Text> : <Text type="secondary">未绑定</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (_, account) => (
        <Space size={8}>
          <Switch
            size="small"
            checked={account.status === 'active'}
            disabled={!canWrite || isSelf(account)}
            loading={switchingId === account.id}
            onChange={(checked) => void toggleStatus(account, checked)}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {account.status === 'active' ? '启用' : '停用'}
          </Text>
        </Space>
      ),
    },
    {
      title: '最近登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 160,
      render: (value: number | null) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (value: number) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_, account) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<QrcodeOutlined />} onClick={() => openWecom(account)}>
            企微登录
          </Button>
          <Button type="link" size="small" icon={<SafetyCertificateOutlined />} onClick={() => openH5(account)}>
            H5 能力
          </Button>
          <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => openReset(account)}>
            重置密码
          </Button>
          {isSelf(account) ? (
            <Tooltip title="不能删除自己的账号">
              <Button type="link" size="small" danger disabled icon={<DeleteOutlined />}>
                删除
              </Button>
            </Tooltip>
          ) : (
            <Popconfirm
              title="删除这个账号？"
              description="账号会被软删除，不能再登录。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void remove(account)}
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const matrixColumns: ColumnsType<PermissionRow> = [
    {
      title: '模块',
      dataIndex: 'group',
      key: 'group',
      width: 110,
      render: (value: string) => <Text type="secondary">{value}</Text>,
    },
    {
      title: '权限',
      dataIndex: 'label',
      key: 'label',
      render: (value: string, row) => (
        <span>
          {value} <Text type="secondary" style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{row.key}</Text>
        </span>
      ),
    },
    ...(matrix?.roles ?? []).map((role) => ({
      title: role.label,
      key: role.role,
      width: 110,
      align: 'center' as const,
      render: (_: unknown, row: PermissionRow) =>
        roleHas(role, row.key) ? (
          <CheckCircleFilled className="matrix-check" />
        ) : (
          <span className="matrix-dash">—</span>
        ),
    })),
  ];

  return (
    <PageContainer
      header={{
        title: '账号与角色',
        subTitle: '机构管理员、主管与只读账号；账号管理仅对管理员开放。',
        extra: canWrite
          ? [
              <Button key="create" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建账号
              </Button>,
            ]
          : undefined,
      }}
    >
      <div className="settings-stack">
        {!canWrite ? (
          <Alert
            type="info"
            showIcon
            message="只读账号"
            description="当前角色可以查看账号列表，但看不到新建、重置密码与停用操作。"
          />
        ) : null}

        {selfAccount && !selfAccount.wecomUserId && !isMockMode ? (
          <Alert
            type="info"
            showIcon
            message="你的账号还没有绑定企微身份"
            description={
              <Space wrap size={10}>
                <span>绑定后可以直接用企业微信扫码登录，不必再输密码。</span>
                <Button
                  size="small"
                  type="primary"
                  icon={<QrcodeOutlined />}
                  loading={bindPending}
                  onClick={() => void startBind()}
                >
                  扫码绑定
                </Button>
              </Space>
            }
          />
        ) : null}

        <Card className="zb-card" variant="borderless" title="账号列表" extra={<Text type="secondary">共 {accounts.length} 个</Text>}>
          <div className="accounts-toolbar">
            <Select
              allowClear
              placeholder="角色"
              style={{ width: 140 }}
              value={roleFilter}
              options={[
                { value: 'admin', label: '机构管理员' },
                { value: 'supervisor', label: '主管' },
                { value: 'viewer', label: '只读' },
              ]}
              onChange={(value) => setRoleFilter(value)}
            />
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 120 }}
              value={statusFilter}
              options={[
                { value: 'active', label: '启用' },
                { value: 'disabled', label: '停用' },
              ]}
              onChange={(value) => setStatusFilter(value)}
            />
            <span className="zb-toolbar-spacer" />
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
          </div>
          <Table<Account>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={accounts}
            pagination={false}
            scroll={{ x: 1060 }}
            locale={{ emptyText: '没有匹配的账号' }}
          />
        </Card>

        <Card className="zb-card" variant="borderless" title="权限矩阵" extra={<Text type="secondary">GET /accounts/permission-matrix</Text>}>
          <Table<PermissionRow>
            className="matrix-table"
            rowKey="key"
            size="small"
            loading={loading}
            columns={matrixColumns}
            dataSource={PERMISSION_ROWS}
            pagination={false}
            scroll={{ x: 620, y: 360 }}
          />
          <Text type="secondary" style={{ display: 'block', marginTop: 10, fontSize: 12 }}>
            以接口返回的矩阵为准；机构管理员拥有全部权限。标「—」表示无该权限。
          </Text>
        </Card>
      </div>

      <Modal
        title="新建账号"
        open={modal === 'create'}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitCreate()}
        onCancel={() => {
          setModal(null);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form<CreateFormValues>
          form={createForm}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          initialValues={{ role: 'supervisor' }}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[
              { required: true, message: '请填写用户名' },
              { pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: '3–32 位字母、数字、点、下划线或短横线' },
            ]}
          >
            <Input autoComplete="off" placeholder="例如：wang.guwen" />
          </Form.Item>
          <Form.Item label="显示名" name="displayName" rules={[{ required: true, message: '请填写显示名' }]}>
            <Input maxLength={20} placeholder="例如：王顾问" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'admin', label: '机构管理员' },
                { value: 'supervisor', label: '主管' },
                { value: 'viewer', label: '只读' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="企微成员 userid（可选）"
            name="wecomUserId"
            rules={[
              { pattern: WECOM_USERID_PATTERN, message: '1–64 位字母、数字与 . _ @ -' },
            ]}
            extra="填企微通讯录里的成员「账号」；填了对方就能扫码登录，留空则只能用密码登录。"
          >
            <Input autoComplete="off" placeholder="例如：wang.guwen" />
          </Form.Item>
          <Form.Item
            label="初始密码"
            name="password"
            rules={[
              { required: true, message: '请填写初始密码' },
              { min: 8, message: '至少 8 位' },
            ]}
            extra="创建后请通过安全渠道交给本人；控制台不会再次显示。"
          >
            <Input.Password autoComplete="new-password" placeholder="至少 8 位" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`患者端 H5 能力${target ? ` · ${target.displayName}` : ''}`}
        open={modal === 'h5'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitH5()}
        onCancel={() => {
          setModal(null);
          setTarget(null);
          h5Form.resetFields();
        }}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="与角色权限分开"
          description="这些能力决定能否审核方案、编辑与审核内容；管理员身份不自动拥有，需要逐项授予。"
        />
        <Form<H5FormValues> form={h5Form} layout="vertical" requiredMark={false} preserve={false}>
          <Form.Item name="h5Permissions" style={{ marginBottom: 0 }}>
            <Checkbox.Group style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {H5_CAPABILITY_OPTIONS.map((item) => (
                <Checkbox key={item.value} value={item.value} style={{ alignItems: 'flex-start' }}>
                  <span style={{ display: 'block', fontWeight: 500 }}>{item.label}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {item.hint}
                  </Text>
                </Checkbox>
              ))}
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`重置密码${target ? ` · ${target.displayName}` : ''}`}
        open={modal === 'reset'}
        okText="重置"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitReset()}
        onCancel={() => {
          setModal(null);
          setTarget(null);
          resetForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form<ResetFormValues> form={resetForm} layout="vertical" requiredMark={false} preserve={false}>
          <Form.Item
            label="新密码"
            name="newPassword"
            rules={[
              { required: true, message: '请填写新密码' },
              { min: 8, message: '至少 8 位' },
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item
            label="确认新密码"
            name="confirmPassword"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                  return Promise.reject(new Error('两次输入不一致'));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder="再次输入" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`企微成员${target ? ` · ${target.displayName}` : ''}`}
        open={modal === 'wecom'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitWecom()}
        onCancel={() => {
          setModal(null);
          setTarget(null);
          wecomForm.resetFields();
        }}
        destroyOnHidden
      >
        {canScanBind ? (
          <div className="wecom-bind-scan">
            <Button
              type="primary"
              icon={<QrcodeOutlined />}
              loading={bindPending}
              onClick={() => void startBind()}
            >
              扫码绑定我的企微身份
            </Button>
            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              用本人企业微信扫码后自动绑定，不需要填写 userid；扫码完成会回到本页并刷新。
            </Text>
          </div>
        ) : null}
        <Form<WecomFormValues> form={wecomForm} layout="vertical" requiredMark={false} preserve={false}>
          <Form.Item
            label={canScanBind ? '或手动填写 userid' : '企微成员 userid'}
            name="wecomUserId"
            rules={[
              { pattern: WECOM_USERID_PATTERN, message: '1–64 位字母、数字与 . _ @ -' },
            ]}
            extra="为他人绑定时填写对方在企业微信通讯录里的「账号」（UserID）；对方也可以用自己的账号登录后扫码自助绑定。清空并保存即解绑。"
          >
            <Input autoComplete="off" placeholder="例如：wang.guwen" />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ fontSize: 12 }}>
          扫码绑定只能绑定扫码人自己的企微身份；登录门槛是「知伴顾问助手」的可见范围，成员被移出后最多 8 小时内会话失效。
        </Text>
      </Modal>
    </PageContainer>
  );
}
