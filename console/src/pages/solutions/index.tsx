import { ArrowRightOutlined, CheckCircleOutlined, DeploymentUnitOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Card, Empty, Space, Spin, Statistic, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { listSkills, listSolutionPacks } from '../../mock/skills.ts';
import { solutionBlurb } from '../../sample/catalog.ts';
import type { Skill, SolutionPack } from '../../types.ts';
import '../wp-l.css';
import './solutions.css';

const { Paragraph, Text, Title } = Typography;

export default function SolutionsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [packs, setPacks] = useState<SolutionPack[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([listSolutionPacks(), listSkills()])
      .then(([packResult, skillResult]) => {
        setPacks(packResult.items);
        setSkills([...skillResult.installed, ...skillResult.upcoming]);
      })
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '方案包加载失败');
      })
      .finally(() => setLoading(false));
  }, [message]);

  const enabledPack = packs.find((pack) => pack.status === 'enabled');
  const upcomingPacks = packs.filter((pack) => pack.status === 'coming_soon');
  const skillName = (id: string) => skills.find((skill) => skill.id === id)?.name ?? id;

  if (loading) {
    return (
      <div className="app-loading" style={{ minHeight: 320 }}>
        <Spin />
        <div className="zb-muted" style={{ marginTop: 12 }}>正在加载方案包…</div>
      </div>
    );
  }

  return (
    <PageContainer
      header={{
        title: '行业方案包',
        subTitle: '按行业组合知识、风险规则与技能；P1 已启用通用健康调理服务。',
      }}
    >
      <div className="solutions-stack">
        {enabledPack ? (
          <Card className="solution-hero" variant="borderless">
            <div className="solution-hero-main">
              <Tag className="solution-hero-tag" bordered={false} color="green">
                已启用
              </Tag>
              <Title level={3} className="solution-hero-title">
                {enabledPack.name}
              </Title>
              <Paragraph className="solution-hero-desc">{enabledPack.description}</Paragraph>
              <Space size={[6, 6]} wrap className="solution-skill-tags">
                {enabledPack.skillIds.map((id) => (
                  <Tag key={id} bordered={false}>
                    <CheckCircleOutlined /> {skillName(id)}
                  </Tag>
                ))}
              </Space>
              <Space wrap className="solution-hero-actions">
                <Button type="primary" onClick={() => navigate('/knowledge')}>
                  查看知识库
                </Button>
                <Button onClick={() => navigate('/rules')}>查看风险规则</Button>
                <Button type="text" onClick={() => navigate('/skills')}>
                  查看技能 <ArrowRightOutlined />
                </Button>
              </Space>
            </div>
            <div className="solution-hero-stats">
              <Statistic title="知识条目" value={enabledPack.knowledgeCount} suffix="条" />
              <Statistic title="风险规则" value={enabledPack.ruleCount} suffix="条" />
              <Statistic title="组合技能" value={enabledPack.skillIds.length} suffix="项" />
            </div>
          </Card>
        ) : (
          <Card className="zb-card" variant="borderless">
            <Empty description="还没有启用的方案包" />
          </Card>
        )}

        <Card
          className="zb-card"
          variant="borderless"
          title="即将上线"
          extra={<Text type="secondary">C 档 · 点击查看介绍</Text>}
        >
          {upcomingPacks.length === 0 ? (
            <Empty description="暂无即将上线的方案包" />
          ) : (
            <div className="solutions-grid">
              {upcomingPacks.map((pack) => (
                <Card
                  key={pack.id}
                  className="solution-card"
                  hoverable
                  onClick={() => navigate(`/solutions/${pack.id}`)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') navigate(`/solutions/${pack.id}`);
                  }}
                >
                  <div className="solution-card-icon">
                    <DeploymentUnitOutlined />
                  </div>
                  <Text strong className="solution-card-name">
                    {pack.name}
                  </Text>
                  <Paragraph type="secondary" className="solution-card-desc">
                    {solutionBlurb(pack.id, pack.description)}
                  </Paragraph>
                  <Text className="solution-card-link">
                    查看介绍 <ArrowRightOutlined />
                  </Text>
                </Card>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
