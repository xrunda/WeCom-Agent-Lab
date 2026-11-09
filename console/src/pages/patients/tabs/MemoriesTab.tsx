import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatDateTime } from '../../../utils/format.ts';
import {
  deleteMemory,
  listMemories,
  MEMORY_CATEGORY_LABELS,
  MEMORY_SUBJECT_LABELS,
  updateMemory,
  type Memory,
  type MemoryCategory,
  type MemorySubject,
} from '../../../mock/patients.ts';

const { Paragraph, Text } = Typography;

const CATEGORY_ORDER: MemoryCategory[] = [
  'dietary_taboo',
  'routine',
  'goal',
  'body',
  'family',
  'preference',
  'other',
];

export interface MemoriesTabProps {
  patientId: string;
  canWrite: boolean;
  onChanged: () => void;
}

export function MemoriesTab({ patientId, canWrite, onChanged }: MemoriesTabProps) {
  const { message } = App.useApp();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<MemoryCategory | undefined>();
  const [editing, setEditing] = useState<Memory | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{
    category: MemoryCategory;
    subject: MemorySubject;
    content: string;
  }>();

  const load = useCallback(() => {
    setLoading(true);
    listMemories(patientId, category)
      .then(setMemories)
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '加载记忆失败');
      })
      .finally(() => setLoading(false));
  }, [patientId, category, message]);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((key) => ({
      key,
      label: MEMORY_CATEGORY_LABELS[key],
      items: memories.filter((item) => item.category === key),
    })).filter((group) => group.items.length > 0);
  }, [memories]);

  const openEdit = (memory: Memory) => {
    setEditing(memory);
    form.setFieldsValue({
      category: memory.category,
      subject: memory.subject,
      content: memory.content,
    });
  };

  const submitEdit = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateMemory(editing.id, values);
      message.success('记忆已更新，Agent 下一轮生效');
      setEditing(null);
      load();
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (memory: Memory) => {
    try {
      await deleteMemory(memory.id);
      message.success('记忆已删除，Agent 下一轮不再引用');
      load();
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="患者的记忆，患者做主"
        description="每条记忆都标出来源原话；编辑与删除立即生效，并写入审计日志。"
      />

      <Space wrap>
        <Select
          allowClear
          placeholder="按分类筛选"
          style={{ minWidth: 200 }}
          value={category}
          options={CATEGORY_ORDER.map((key) => ({ label: MEMORY_CATEGORY_LABELS[key], value: key }))}
          onChange={setCategory}
        />
        <Text type="secondary">共 {memories.length} 条</Text>
      </Space>

      {loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin tip="正在加载记忆…" />
        </div>
      ) : memories.length === 0 ? (
        <Empty description="还没有记忆。Agent 会从对话中抽取，也可由顾问手动补充。" />
      ) : (
        grouped.map((group) => (
          <div key={group.key}>
            <Text strong>{group.label}</Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              bordered
              dataSource={group.items}
              renderItem={(memory) => (
                <List.Item
                  actions={
                    canWrite
                      ? [
                          <Button
                            key="edit"
                            type="link"
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => openEdit(memory)}
                          >
                            编辑
                          </Button>,
                          <Popconfirm
                            key="delete"
                            title="删除这条记忆？"
                            description="Agent 下一轮将不再引用它。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => void remove(memory)}
                          >
                            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                              删除
                            </Button>
                          </Popconfirm>,
                        ]
                      : undefined
                  }
                >
                  <List.Item.Meta
                    title={
                      <Space size={8} wrap>
                        <Text>{memory.content}</Text>
                        <Tag bordered={false} color={memory.subject === 'self' ? 'blue' : 'orange'}>
                          {MEMORY_SUBJECT_LABELS[memory.subject]}
                        </Tag>
                        {memory.createdBy === 'agent' ? (
                          <Tag bordered={false}>Agent 抽取</Tag>
                        ) : (
                          <Tag bordered={false}>人工添加</Tag>
                        )}
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={2}>
                        {memory.sourceText ? (
                          <Text type="secondary">来源：「{memory.sourceText}」</Text>
                        ) : (
                          <Text type="secondary">来源：人工录入</Text>
                        )}
                        <Text type="secondary">记录于 {formatDateTime(memory.createdAt)}</Text>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </div>
        ))
      )}

      <Modal
        title="编辑记忆"
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={() => void submitEdit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="分类" name="category" rules={[{ required: true }]}>
            <Select
              options={CATEGORY_ORDER.map((key) => ({
                label: MEMORY_CATEGORY_LABELS[key],
                value: key,
              }))}
            />
          </Form.Item>
          <Form.Item label="归属" name="subject" rules={[{ required: true }]}>
            <Select
              options={(Object.keys(MEMORY_SUBJECT_LABELS) as MemorySubject[]).map((key) => ({
                label: MEMORY_SUBJECT_LABELS[key],
                value: key,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="内容"
            name="content"
            rules={[{ required: true, message: '请填写记忆内容' }]}
          >
            <Input.TextArea rows={3} maxLength={200} showCount placeholder="一句话事实，不超过 200 字" />
          </Form.Item>
          <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
            家属的事请把归属选为「家属」，避免记成患者本人的事实。
          </Paragraph>
        </Form>
      </Modal>
    </Space>
  );
}
