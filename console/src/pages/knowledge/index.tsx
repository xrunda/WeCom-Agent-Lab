import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  App,
  AutoComplete,
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
  Tree,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState, type Key } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import {
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  listKnowledgeCategories,
  updateKnowledge,
  type KnowledgeCategory,
} from '../../mock/knowledge.ts';
import type { KnowledgeEntry } from '../../types.ts';
import { formatDateTime } from '../../utils/format.ts';
import '../wp-l.css';
import './knowledge.css';

const { Paragraph, Text } = Typography;

interface KnowledgeFormValues {
  category: string;
  title: string;
  content: string;
  enabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function KnowledgePage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const canWrite = can('tenant.write');

  const [items, setItems] = useState<KnowledgeEntry[]>([]);
  const [categories, setCategories] = useState<KnowledgeCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string | undefined>();
  const [enabledFilter, setEnabledFilter] = useState<boolean | undefined>();
  const [search, setSearch] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<Key[]>(['all']);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<KnowledgeFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, categoryResult] = await Promise.all([
        listKnowledge({ category, enabled: enabledFilter, q: search, pageSize: 200 }),
        listKnowledgeCategories(),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setCategories(categoryResult.items);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [category, enabledFilter, message, search]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const refresh = () => setReloadToken((token) => token + 1);

  const treeData = useMemo(
    () => [
      {
        key: 'all',
        title: (
          <span>
            全部分类<span className="zb-tree-count">{categories.reduce((sum, item) => sum + item.count, 0)}</span>
          </span>
        ),
        children: categories.map((item) => ({
          key: item.category,
          title: (
            <span>
              {item.category}
              <span className="zb-tree-count">{item.count}</span>
            </span>
          ),
        })),
      },
    ],
    [categories],
  );

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ category: category ?? '', title: '', content: '', enabled: true });
    setModalOpen(true);
  };

  const openEdit = (entry: KnowledgeEntry) => {
    setEditing(entry);
    form.setFieldsValue({
      category: entry.category,
      title: entry.title,
      content: entry.content,
      enabled: entry.enabled,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await updateKnowledge(editing.id, values);
        message.success('已保存，下一轮对话生效');
      } else {
        const created = await createKnowledge(values);
        message.success('已新增，下一轮对话生效');
        setCategory(created.category);
        setSearch('');
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      refresh();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (entry: KnowledgeEntry, enabled: boolean) => {
    setSwitchingId(entry.id);
    try {
      const next = await updateKnowledge(entry.id, { enabled });
      setItems((current) => current.map((item) => (item.id === entry.id ? next : item)));
      message.success(enabled ? '已启用' : '已停用');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSwitchingId(null);
    }
  };

  const remove = async (entry: KnowledgeEntry) => {
    try {
      await deleteKnowledge(entry.id);
      message.success('已删除');
      refresh();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const columns: ColumnsType<KnowledgeEntry> = [
    {
      title: '知识条目',
      dataIndex: 'title',
      key: 'title',
      render: (_, entry) => (
        <div className="knowledge-title-cell">
          <Text strong>{entry.title}</Text>
          <Paragraph type="secondary" ellipsis={{ rows: 1, tooltip: entry.content }} style={{ margin: 0 }}>
            {entry.content}
          </Paragraph>
        </div>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 110,
      render: (value: string) => <Tag bordered={false}>{value}</Tag>,
    },
    {
      title: '命中',
      dataIndex: 'hits',
      key: 'hits',
      width: 76,
      align: 'right',
      render: (value: number) => (
        <span className="knowledge-hits" style={{ whiteSpace: 'nowrap' }}>
          {value} 次
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 112,
      render: (_, entry) => (
        <Space size={6}>
          <Switch
            size="small"
            checked={entry.enabled}
            disabled={!canWrite}
            loading={switchingId === entry.id}
            onChange={(checked) => void toggleEnabled(entry, checked)}
          />
          <Text type={entry.enabled ? undefined : 'secondary'} style={{ fontSize: 12 }}>
            {entry.enabled ? '启用' : '停用'}
          </Text>
        </Space>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 168,
      render: (value: number) => (
        <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(value)}
        </Text>
      ),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 120,
            render: (_: unknown, entry: KnowledgeEntry) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(entry)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除这条知识？"
                  description="删除后不会被新一轮对话引用。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(entry)}
                >
                  <Button type="link" size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          } as ColumnsType<KnowledgeEntry>[number],
        ]
      : []),
  ];

  return (
    <PageContainer
      header={{
        title: '知识库',
        subTitle: '分类维护知识条目；保存后重新生成 skill 资源，下一轮对话生效。',
        extra: canWrite
          ? [
              <Button key="create" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增知识
              </Button>,
            ]
          : undefined,
      }}
    >
      <div className="knowledge-layout">
        <Card className="zb-card zb-side-card" title="分类" size="small">
          <Tree
            blockNode
            treeData={treeData}
            selectedKeys={[category ?? 'all']}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onSelect={(keys) => {
              const key = keys[0] as string | undefined;
              setCategory(!key || key === 'all' ? undefined : key);
            }}
          />
          <div className="knowledge-category-foot">
            <Text type="secondary">共 {total} 条{search ? '匹配结果' : ''}</Text>
          </div>
        </Card>

        <Card className="zb-card" variant="borderless">
          <div className="zb-toolbar">
            <Input.Search
              allowClear
              placeholder="搜索标题或内容"
              style={{ width: 260 }}
              onSearch={(value) => setSearch(value.trim())}
            />
            <Select
              allowClear
              placeholder="启用状态"
              style={{ width: 130 }}
              value={enabledFilter}
              options={[
                { value: true, label: '已启用' },
                { value: false, label: '已停用' },
              ]}
              onChange={(value) => setEnabledFilter(value ?? undefined)}
            />
            {category ? <Tag closable onClose={() => setCategory(undefined)}>{category}</Tag> : null}
            <span className="zb-toolbar-spacer" />
            {!canWrite ? <Text type="secondary">只读账号，无法修改知识库</Text> : null}
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          </div>

          <Table<KnowledgeEntry>
            rowKey="id"
            size="middle"
            tableLayout="fixed"
            loading={loading}
            columns={columns}
            dataSource={items}
            pagination={false}
            locale={{ emptyText: '没有匹配的知识条目' }}
          />
        </Card>
      </div>

      <Modal
        title={editing ? '编辑知识' : '新增知识'}
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
        <Form<KnowledgeFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          initialValues={{ enabled: true }}
        >
          <Form.Item
            label="分类"
            name="category"
            rules={[{ required: true, message: '请选择或填写分类' }]}
          >
            <AutoComplete
              placeholder="例如：饮食建议"
              options={categories.map((item) => ({ value: item.category }))}
              filterOption={(input, option) =>
                String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            label="标题"
            name="title"
            rules={[{ required: true, message: '请填写标题' }]}
          >
            <Input maxLength={80} showCount placeholder="一句话说明这条知识" />
          </Form.Item>
          <Form.Item
            label="内容"
            name="content"
            rules={[{ required: true, message: '请填写内容' }]}
            extra="引用时会作为 Agent 的依据；建议写成可执行的一句话。"
          >
            <Input.TextArea rows={5} maxLength={500} showCount placeholder="例如：晚餐尽量在 19 点前完成。" />
          </Form.Item>
          <Form.Item label="保存后启用" name="enabled" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
