import { ArrowLeftOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Button, Card, Descriptions, Result, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ComingSoonPage } from '../../components/ComingSoonPage.tsx';
import { getSolutionPack, listSkills } from '../../mock/skills.ts';
import { solutionBlurb } from '../../sample/catalog.ts';
import type { Skill, SolutionPack } from '../../types.ts';
import '../wp-l.css';

const { Paragraph } = Typography;

export default function SolutionDetailPage() {
  const { solutionId } = useParams<{ solutionId: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [pack, setPack] = useState<SolutionPack | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!solutionId) {
      setLoading(false);
      return;
    }
    Promise.all([getSolutionPack(solutionId), listSkills()])
      .then(([packResult, skillResult]) => {
        setPack(packResult);
        setSkills([...skillResult.installed, ...skillResult.upcoming]);
      })
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '方案包加载失败');
      })
      .finally(() => setLoading(false));
  }, [message, solutionId]);

  if (loading) {
    return (
      <div className="app-loading" style={{ minHeight: 320 }}>
        <Spin />
      </div>
    );
  }

  if (!pack) {
    return (
      <Result
        status="404"
        title="方案包不存在"
        subTitle="这个方案包可能已下线，或链接有误。"
        extra={
          <Button type="primary" onClick={() => navigate('/solutions')}>
            返回行业方案包
          </Button>
        }
      />
    );
  }

  if (pack.status === 'coming_soon') {
    return (
      <ComingSoonPage title={pack.name} description={solutionBlurb(pack.id, pack.description)} />
    );
  }

  const skillName = (id: string) => skills.find((skill) => skill.id === id)?.name ?? id;

  return (
    <PageContainer
      header={{
        title: pack.name,
        subTitle: pack.description,
        extra: [
          <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => navigate('/solutions')}>
            返回行业方案包
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
            <Descriptions.Item label="知识条目">{pack.knowledgeCount} 条</Descriptions.Item>
            <Descriptions.Item label="风险规则">{pack.ruleCount} 条</Descriptions.Item>
            <Descriptions.Item label="组合技能">
              <Space size={[4, 4]} wrap>
                {pack.skillIds.map((id) => (
                  <Tag key={id} bordered={false}>
                    {skillName(id)}
                  </Tag>
                ))}
              </Space>
            </Descriptions.Item>
          </Descriptions>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            方案包把知识库条目、风险规则与技能组合在一起。机构可以在对应页面继续维护内容。
          </Paragraph>
          <Space wrap>
            <Button type="primary" onClick={() => navigate('/knowledge')}>
              查看知识库
            </Button>
            <Button onClick={() => navigate('/rules')}>查看风险规则</Button>
            <Button onClick={() => navigate('/skills')}>查看技能市场</Button>
          </Space>
        </Space>
      </Card>
    </PageContainer>
  );
}
