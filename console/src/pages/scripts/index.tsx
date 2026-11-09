import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Card, Empty, Input, Space, Tag, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { SampleDataTag } from '../../components/SampleDataTag.tsx';
import { listScripts } from '../../mock/scripts.ts';
import type { ScriptTemplate } from '../../types.ts';
import '../wp-l.css';
import './scripts.css';

const { Paragraph, Text } = Typography;

export default function ScriptsPage() {
  const { message } = App.useApp();
  const [items, setItems] = useState<ScriptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listScripts({
        category: category === 'all' ? undefined : category,
        q: search || undefined,
      });
      setItems(result.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '话术加载失败');
    } finally {
      setLoading(false);
    }
  }, [category, message, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listScripts()
      .then((result) => setCategories([...new Set(result.items.map((item) => item.category))]))
      .catch(() => setCategories([]));
  }, []);

  const copy = async (script: ScriptTemplate) => {
    try {
      await navigator.clipboard.writeText(script.content);
      message.success('已复制话术，可直接粘贴到企微');
    } catch {
      message.warning('当前浏览器不允许自动复制，请手动选中文本');
    }
  };

  return (
    <PageContainer
      header={{
        title: '话术库',
        subTitle: '团队常用表达示例，可按分类查找并复制到企微。',
        extra: [<SampleDataTag key="sample" />],
      }}
    >
      <Card className="zb-card" variant="borderless">
        <div className="zb-toolbar">
          <Input.Search
            allowClear
            placeholder="搜索标题、内容或标签"
            style={{ width: 300 }}
            onSearch={(value) => setSearch(value.trim())}
          />
          <span className="zb-toolbar-spacer" />
          <Text type="secondary">共 {items.length} 条示例话术</Text>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
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
            <Empty description="没有匹配的话术" />
          </div>
        ) : (
          <div className="scripts-grid">
            {items.map((script) => (
              <Card
                key={script.id}
                className="script-card"
                size="small"
                loading={loading}
                title={
                  <Space size={8}>
                    <span>{script.title}</span>
                    <Tag bordered={false} color="cyan">
                      {script.category}
                    </Tag>
                  </Space>
                }
                extra={
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => void copy(script)}
                  >
                    复制
                  </Button>
                }
              >
                <Paragraph className="script-content">{script.content}</Paragraph>
                <div className="script-tags">
                  {script.tags.map((tag) => (
                    <Tag key={tag} bordered={false}>
                      #{tag}
                    </Tag>
                  ))}
                  {script.sample ? <Text type="secondary">示例</Text> : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
