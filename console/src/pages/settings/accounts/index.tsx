import {
  CheckCircleFilled,
  DeleteOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
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

import { useAuth } from '../../../auth/AuthContext.tsx';
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
}

interface ResetFormValues {
  newPassword: string;
  confirmPassword: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function AccountsSettingsPage() {
  const { can, session } = useAuth();
  const { message } = App.useApp();
  // 后端 GET /accounts 同样要求 account.write，所以「能看」与「能管」是同一权限
  const canWrite = can('account.write');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<Role | undefined>();
  const [statusFilter, setStatusFilter] = useState<Account['status'] | undefined>();
  const [modal, setModal] = useState<'create' | 'reset' | null>(null);
  const [target, setTarget] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [resetForm] = Form.useForm<ResetFormValues>();

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

  const openCreate = () => {
    createForm.setFieldsValue({
      username: '',
      displayName: '',
      role: 'supervisor',
      password: '',
    });
    setModal('create');
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
      await createAccount(values);
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
      width: 190,
      render: (_, account) => (
        <Space size={4}>
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
            scroll={{ x: 900 }}
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
    </PageContainer>
  );
}
