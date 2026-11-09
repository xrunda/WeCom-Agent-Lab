import { ArrowLeftOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Card, Descriptions, Result, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ComingSoonPage } from '../../components/ComingSoonPage.tsx';
import { getSkill } from '../../mock/skills.ts';
import { skillBlurb } from '../../sample/catalog.ts';
import type { Skill } from '../../types.ts';
import '../wp-l.css';

const { Paragraph } = Typography;

export default function SkillDetailPage() {
  const { skillId } = useParams<{ skillId: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!skillId) {
      setLoading(false);
      return;
    }
    getSkill(skillId)
      .then(setSkill)
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '技能加载失败');
      })
      .finally(() => setLoading(false));
  }, [message, skillId]);

  if (loading) {
    return (
      <div className="app-loading" style={{ minHeight: 320 }}>
        <Spin />
      </div>
    );
  }

  if (!skill) {
    return (
      <Result
        status="404"
        title="技能不存在"
        subTitle="这个技能可能已下线，或链接有误。"
        extra={
          <Button type="primary" onClick={() => navigate('/skills')}>
            返回技能市场
          </Button>
        }
      />
    );
  }

  if (skill.status === 'coming_soon') {
    return (
      <ComingSoonPage
        title={skill.name}
        description={skillBlurb(skill.id, skill.description)}
      />
    );
  }

  return (
    <PageContainer
      header={{
        title: skill.name,
        subTitle: skill.description,
        extra: [
          <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => navigate('/skills')}>
            返回技能市场
          </Button>,
        ],
      }}
    >
      <Card className="zb-card" variant="borderless">
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Tag color="green" bordered={false}>
            已启用
          </Tag>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="技能 ID">{skill.id}</Descriptions.Item>
            <Descriptions.Item label="插件 ID">{skill.pluginId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="版本">{skill.version ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="能力">
              <Space size={[4, 4]} wrap>
                {skill.capabilities.map((capability) => (
                  <Tag key={capability} bordered={false}>
                    {capability}
                  </Tag>
                ))}
              </Space>
            </Descriptions.Item>
          </Descriptions>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            已启用技能由 DSH 插件清单提供。卸载对应插件后，这里会显示为未启用。
          </Paragraph>
        </Space>
      </Card>
    </PageContainer>
  );
}
