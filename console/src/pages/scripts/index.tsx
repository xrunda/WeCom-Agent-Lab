import {
  CopyOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  App,
  AutoComplete,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext.tsx';
import { SampleDataTag } from '../../components/SampleDataTag.tsx';
import { isMockMode } from '../../mock/http.ts';
import {
  createScript,
  deleteScript,
  listScripts,
  SCRIPT_LIMITS,
  updateScript,
} from '../../mock/scripts.ts';
import type { ScriptTemplate } from '../../types.ts';
import '../wp-l.css';
import './scripts.css';

const { Paragraph, Text } = Typography;

type EnabledFilter = 'enabled' | 'all' | 'disabled';

interface ScriptFormValues {
  category: string;
  title: string;
  content: string;
  tags: string[];
  enabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export default function ScriptsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const canWrite = can('tenant.write');

  const [items, setItems] = useState<ScriptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sample, setSample] = useState(isMockMode);
  const [category, setCategory] = useState('all');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('enabled');
  const [search, setSearch] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScriptTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ScriptFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listScripts({
        category: category === 'all' ? undefined : category,
        q: search || undefined,
        enabled:
          enabledFilter === 'all' ? undefined : enabledFilter === 'enabled',
      });
      setItems(result.items);
      setSample(result.sample);
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

  useEffect(() => {
    listScripts()
      .then((result) => setCategories([...new Set(result.items.map((item) => item.category))]))
      .catch(() => setCategories([]));
  }, [reloadToken]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      category: category === 'all' ? '' : category,
      title: '',
      content: '',
      tags: [],
      enabled: true,
    });
    setModalOpen(true);
  };

  const openEdit = (script: ScriptTemplate) => {
    setEditing(script);
    form.setFieldsValue({
      category: script.category,
      title: script.title,
      content: script.content,
      tags: script.tags,
      enabled: script.enabled,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await updateScript(editing.id, values);
        message.success('已保存');
      } else {
        const created = await createScript(values);
        message.success('已新增话术');
        setCategory('all');
        setSearch('');
        if (!created.enabled) setEnabledFilter('all');
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

  const toggleEnabled = async (script: ScriptTemplate, enabled: boolean) => {
    setSwitchingId(script.id);
    try {
      await updateScript(script.id, { enabled });
      message.success(enabled ? '已启用' : '已停用，顾问的启用列表不再显示');
      refresh();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSwitchingId(null);
    }
  };

  const remove = async (script: ScriptTemplate) => {
    try {
      await deleteScript(script.id);
      message.success('已删除');
      refresh();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const copy = async (script: ScriptTemplate) => {
    try {
      await navigator.clipboard.writeText(script.content);
      message.success('已复制话术，可直接粘贴到企微');
    } catch {
      message.warning('当前浏览器不允许自动复制，请手动选中文本');
    }
  };

  const filtered = search !== '' || category !== 'all' || enabledFilter !== 'enabled';
  const emptyDescription = filtered || categories.length > 0 ? '没有匹配的话术' : '还没有话术，新建第一条';

  return (
    <PageContainer
      header={{
        title: '话术库',
        subTitle: sample
          ? '团队常用表达示例；顾问在企微私聊机器人发「话术 关键词」即可查询。'
          : '团队常用话术，在后台维护；顾问在企微私聊机器人查询，停用后查不到。',
        extra: sample ? (
          <SampleDataTag key="sample" />
        ) : canWrite ? (
          <Button key="create" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建话术
          </Button>
        ) : undefined,
      }}
    >
      <Card className="zb-card" variant="borderless">
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          顾问不用登录后台：在企微私聊机器人发「话术 关键词」查询，回复「话术 1」取全文，再自行粘贴到客户群。机器人不会自动发送。
        </Paragraph>
        <div className="zb-toolbar">
          <Input.Search
            allowClear
            placeholder="搜索标题、内容或标签"
            style={{ width: 300 }}
            onSearch={(value) => setSearch(value.trim())}
          />
          <Select<EnabledFilter>
            style={{ width: 130 }}
            value={enabledFilter}
            options={[
              { value: 'enabled', label: '已启用' },
              { value: 'all', label: '全部' },
              { value: 'disabled', label: '已停用' },
            ]}
            onChange={setEnabledFilter}
          />
          <span className="zb-toolbar-spacer" />
          {!canWrite && !sample ? (
            <Text type="secondary">只读账号，无法修改话术</Text>
          ) : null}
          <Text type="secondary">
            共 {items.length} 条{sample ? '示例' : ''}话术
          </Text>
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            刷新
          </Button>
        </div>

        <Tabs
          activeKey={category}
          onChange={setCategory}
          items={[
            { key: 'all', label: '全部' },
            ...categories.map((item) => ({ key: item, label: item })),
          ]}
        />

        {!loading && items.length === 0 ? (
          <div className="zb-empty-block">
            <Empty description={emptyDescription}>
              {!filtered && canWrite && !sample ? (
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新建第一条话术
                </Button>
              ) : null}
            </Empty>
          </div>
        ) : (
          <div className="scripts-grid">
            {items.map((script) => (
              <Card
                key={script.id}
                className={script.enabled ? 'script-card' : 'script-card script-card-disabled'}
                size="small"
                loading={loading}
                title={
                  <Space size={8}>
                    <span>{script.title}</span>
                    <Tag bordered={false} color="cyan">
                      {script.category}
                    </Tag>
                    {script.enabled ? null : (
                      <Tag bordered={false} color="default">
                        已停用
                      </Tag>
                    )}
                  </Space>
                }
                extra={
                  <Space size={0}>
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => void copy(script)}
                    >
                      复制
                    </Button>
                    {canWrite ? (
                      <>
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openEdit(script)}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title="删除这条话术？"
                          description="删除后列表不再显示，顾问在企微也查不到。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void remove(script)}
                        >
                          <Button type="text" size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </>
                    ) : null}
                  </Space>
                }
              >
                <Paragraph className="script-content">{script.content}</Paragraph>
                <div className="script-tags">
                  {script.tags.map((tag) => (
                    <Tag key={tag} bordered={false}>
                      #{tag}
                    </Tag>
                  ))}
                  <span className="zb-toolbar-spacer" />
                  {canWrite ? (
                    <Space size={6}>
                      <Text type={script.enabled ? undefined : 'secondary'} style={{ fontSize: 12 }}>
                        {script.enabled ? '启用中' : '已停用'}
                      </Text>
                      <Switch
                        size="small"
                        checked={script.enabled}
                        loading={switchingId === script.id}
                        onChange={(checked) => void toggleEnabled(script, checked)}
                      />
                    </Space>
                  ) : script.sample ? (
                    <Text type="secondary">示例</Text>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>

      <Modal
        title={editing ? '编辑话术' : '新建话术'}
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
        <Form<ScriptFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          initialValues={{ tags: [], enabled: true }}
        >
          <Form.Item
            label="分类"
            name="category"
            rules={[{ required: true, message: '请选择或填写分类' }]}
          >
            <AutoComplete
              placeholder="例如：饮食建议"
              options={categories.map((item) => ({ value: item }))}
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
            <Input maxLength={SCRIPT_LIMITS.title} showCount placeholder="一句话说明这条话术" />
          </Form.Item>
          <Form.Item
            label="内容"
            name="content"
            rules={[{ required: true, message: '请填写内容' }]}
            extra="顾问在企微私聊机器人发「话术 关键词」即可查到；内容不会进入 Agent 草稿，也不会自动发到客户群。"
          >
            <Input.TextArea
              rows={5}
              maxLength={SCRIPT_LIMITS.content}
              showCount
              placeholder="例如：可以先记录这一周的饮食，下周我们再看趋势。"
            />
          </Form.Item>
          <Form.Item
            label="标签"
            name="tags"
            extra={`最多 ${SCRIPT_LIMITS.tags} 个，每个不超过 ${SCRIPT_LIMITS.tag} 字。`}
            rules={[
              {
                validator: (_, value: string[] | undefined) => {
                  if (value && value.length > SCRIPT_LIMITS.tags) {
                    return Promise.reject(new Error(`标签最多 ${SCRIPT_LIMITS.tags} 个`));
                  }
                  if (value?.some((tag) => tag.trim().length > SCRIPT_LIMITS.tag)) {
                    return Promise.reject(
                      new Error(`标签不能超过 ${SCRIPT_LIMITS.tag} 字`),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Select
              mode="tags"
              maxCount={SCRIPT_LIMITS.tags}
              tokenSeparators={[',', '，']}
              placeholder="输入后回车，例如：复诊、饮食"
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Form.Item label="保存后启用" name="enabled" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
