import { PageContainer } from '@ant-design/pro-components';
import { Alert, App, Button, Form, Input, Modal, Radio, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth, useTerm } from '../../auth/AuthContext.tsx';
import { listAdvisors, type Advisor } from '../../mock/advisors.ts';
import { listPatients, type Patient } from '../../mock/patients.ts';
import {
  bindPatient,
  GROUP_STATUS_COLORS,
  GROUP_STATUS_LABELS,
  listGroups,
  updateGroup,
  type Group,
  type GroupStatus,
} from '../../mock/groups.ts';
import { formatDateTime, formatRelative } from '../../utils/format.ts';
import './groups.css';

const { Text } = Typography;

interface EditForm {
  name: string;
  advisorId?: string;
  bindMode: 'none' | 'existing' | 'new';
  patientId?: string;
  newPatientName?: string;
  newPatientTags?: string[];
}

const STATUS_OPTIONS = (Object.keys(GROUP_STATUS_LABELS) as GroupStatus[]).map((status) => ({
  label: GROUP_STATUS_LABELS[status],
  value: status,
}));

export default function GroupsPage() {
  const term = useTerm();
  const { can } = useAuth();
  const { message } = App.useApp();
  const canWrite = can('group.write');

  const [groups, setGroups] = useState<Group[]>([]);
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<GroupStatus | undefined>();
  const [editing, setEditing] = useState<Group | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [form] = Form.useForm<EditForm>();

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listGroups({ q: keyword, status }),
      listAdvisors(),
      listPatients({ pageSize: 100 }),
      // 待确认群数走真实接口统计，避免 mock 模块的 fixture 数量混进真实模式
      listGroups({ status: 'pending', pageSize: 1 }),
    ])
      .then(([groupPage, advisorList, patientPage, pendingPage]) => {
        if (cancelled) return;
        setGroups(groupPage.items);
        setAdvisors(advisorList);
        setPatients(patientPage.items);
        setPending(pendingPage.total);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keyword, status, refreshKey, message]);

  const patientName = useMemo(
    () => new Map(patients.map((item) => [item.id, item.displayName])),
    [patients],
  );
  const advisorName = useMemo(
    () => new Map(advisors.map((item) => [item.id, item.name])),
    [advisors],
  );

  const changeStatus = async (group: Group, next: GroupStatus) => {
    try {
      await updateGroup(group.id, { status: next });
      message.success(`「${group.name}」已切换为${GROUP_STATUS_LABELS[next]}`);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '状态更新失败');
    }
  };

  const openEdit = (group: Group) => {
    setEditing(group);
    form.setFieldsValue({
      name: group.name,
      advisorId: group.advisorId ?? undefined,
      bindMode: 'none',
      patientId: undefined,
      newPatientName: undefined,
      newPatientTags: [],
    });
  };

  const submitEdit = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateGroup(editing.id, {
        name: values.name,
        advisorId: values.advisorId ?? null,
      });
      if (values.bindMode === 'existing' && values.patientId) {
        await bindPatient(editing.id, { patientId: values.patientId });
      } else if (values.bindMode === 'new' && values.newPatientName) {
        await bindPatient(editing.id, {
          newPatient: {
            displayName: values.newPatientName,
            tags: values.newPatientTags ?? [],
            consent: 'unknown',
          },
        });
      }
      message.success('群设置已保存');
      setEditing(null);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const bindablePatients = editing
    ? patients.filter((item) => !editing.patientIds.includes(item.id))
    : [];

  const columns: TableProps<Group>['columns'] = [
    {
      title: '群名',
      dataIndex: 'name',
      render: (value: string, group) => (
        <Space size={6} wrap>
          <Text strong={group.status === 'pending'}>{value}</Text>
          {group.demo ? (
            <Tag bordered={false} color="purple">
              演示环境
            </Tag>
          ) : null}
          {group.nameSource === 'roomid' ? <Tag bordered={false}>未命名</Tag> : null}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (value: GroupStatus, group) =>
        canWrite ? (
          <Select
            size="small"
            value={value}
            style={{ width: 120 }}
            options={STATUS_OPTIONS}
            onChange={(next) => void changeStatus(group, next)}
          />
        ) : (
          <Tag bordered={false} color={GROUP_STATUS_COLORS[value]}>
            {GROUP_STATUS_LABELS[value]}
          </Tag>
        ),
    },
    {
      title: `绑定${term}`,
      dataIndex: 'patientIds',
      width: 170,
      render: (value: string[]) =>
        value.length > 0 ? (
          <Space size={4} wrap>
            {value.map((id) => (
              <Tag key={id} bordered={false}>
                {patientName.get(id) ?? id}
              </Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">未绑定</Text>
        ),
    },
    {
      title: '顾问',
      dataIndex: 'advisorId',
      width: 110,
      render: (value: string | null) =>
        value ? (advisorName.get(value) ?? value) : <Text type="secondary">未分配</Text>,
    },
    {
      title: '外部成员',
      dataIndex: 'externalMemberCount',
      width: 170,
      render: (value: number, group) => (
        <Space size={4} wrap>
          <Text>
            {value}/{group.memberCount}
          </Text>
          {group.consent.agreed > 0 ? (
            <Tag bordered={false} color="green">
              同意 {group.consent.agreed}
            </Tag>
          ) : (
            <Tag bordered={false} color="gold">
              待确认 {group.consent.unknown + group.consent.disagreed}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '最近活跃',
      dataIndex: 'lastActiveAt',
      width: 150,
      render: (value: number | null) => (
        <Text type="secondary" title={formatDateTime(value)}>
          {formatRelative(value)}
        </Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, group) => (
        <Button type="link" size="small" disabled={!canWrite} onClick={() => openEdit(group)}>
          编辑
        </Button>
      ),
    },
  ];

  return (
    <PageContainer
      header={{
        title: '服务群',
        subTitle: '只有「服务中」的群会进入 Agent 回合；其他状态只保留采集，不产出草稿。',
      }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {pending > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`有 ${pending} 个待确认群`}
            description="存档里发现的新群默认待确认。确认服务范围后，只有「服务中」的群会触发 Agent。"
            action={
              <Button size="small" onClick={() => setStatus('pending')}>
                只看待确认
              </Button>
            }
          />
        ) : null}

        <Space wrap size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap size={12}>
            <Input.Search
              allowClear
              placeholder="搜索群名"
              style={{ width: 240 }}
              onSearch={(value) => setKeyword(value.trim())}
              onChange={(event) => {
                if (!event.target.value) setKeyword('');
              }}
            />
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 160 }}
              value={status}
              options={STATUS_OPTIONS}
              onChange={setStatus}
            />
          </Space>
          <Text type="secondary">共 {groups.length} 个群（不含未含外部成员的群）</Text>
        </Space>

        <Table<Group>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={groups}
          rowClassName={(group) => (group.status === 'pending' ? 'group-row-pending' : '')}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 980 }}
        />
      </Space>

      <Modal
        title={editing ? `编辑「${editing.name}」` : '编辑群'}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={() => void submitEdit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="群名" name="name" rules={[{ required: true, message: '请填写群名' }]}>
            <Input maxLength={40} />
          </Form.Item>
          <Form.Item label="负责顾问" name="advisorId">
            <Select
              allowClear
              placeholder="选择顾问"
              options={advisors
                .filter((item) => item.status !== 'left')
                .map((item) => ({ label: item.name, value: item.id }))}
            />
          </Form.Item>
          <Form.Item label="绑定患者" name="bindMode">
            <Radio.Group
              optionType="button"
              options={[
                { label: '暂不绑定', value: 'none' },
                { label: '选择已有', value: 'existing' },
                { label: '新建患者', value: 'new' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) => {
              const mode = getFieldValue('bindMode') as EditForm['bindMode'];
              if (mode === 'existing') {
                return (
                  <Form.Item
                    label={`选择${term}`}
                    name="patientId"
                    rules={[{ required: true, message: '请选择患者' }]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="选择未绑定到该群的患者"
                      options={bindablePatients.map((item) => ({
                        label: item.displayName,
                        value: item.id,
                      }))}
                    />
                  </Form.Item>
                );
              }
              if (mode === 'new') {
                return (
                  <>
                    <Form.Item
                      label={`新建${term}备注名`}
                      name="newPatientName"
                      rules={[{ required: true, message: '请填写备注名' }]}
                    >
                      <Input maxLength={30} placeholder="例如：周先生" />
                    </Form.Item>
                    <Form.Item label="标签" name="newPatientTags">
                      <Select mode="tags" placeholder="输入标签后回车" />
                    </Form.Item>
                  </>
                );
              }
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
