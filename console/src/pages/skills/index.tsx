import {
  ApartmentOutlined,
  AppstoreOutlined,
  BookOutlined,
  CameraOutlined,
  CloudServerOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { App, Card, Descriptions, Drawer, Empty, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { listSkills, type SkillList } from '../../mock/skills.ts';
import { skillBlurb } from '../../sample/catalog.ts';
import type { Skill } from '../../types.ts';
import '../wp-l.css';
import './skills.css';

const { Paragraph, Text, Title } = Typography;

function iconFor(skill: Skill) {
  if (skill.capabilities.includes('vision')) return <CameraOutlined />;
  if (skill.capabilities.includes('memory')) return <DatabaseOutlined />;
  if (skill.capabilities.includes('schedule')) return <ClockCircleOutlined />;
  if (skill.capabilities.includes('risk')) return <SafetyCertificateOutlined />;
  if (skill.capabilities.includes('knowledge')) return <BookOutlined />;
  if (skill.capabilities.includes('route') || skill.capabilities.includes('turn')) return <ApartmentOutlined />;
  if (skill.capabilities.includes('archive') || skill.capabilities.includes('bot')) return <CloudServerOutlined />;
  return <AppstoreOutlined />;
}

function tintFor(skill: Skill): string {
  if (skill.capabilities.includes('vision')) return 'amber';
  if (skill.capabilities.includes('memory')) return 'violet';
  if (skill.capabilities.includes('schedule')) return 'sky';
  if (skill.capabilities.includes('risk')) return 'rose';
  if (skill.capabilities.includes('knowledge')) return 'teal';
  return 'slate';
}

export default function SkillsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<SkillList | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Skill | null>(null);

  useEffect(() => {
    listSkills()
      .then(setData)
      .catch((error: unknown) => {
        message.error(error instanceof Error ? error.message : '技能清单加载失败');
      })
      .finally(() => setLoading(false));
  }, [message]);

  return (
    <PageContainer
      header={{
        title: '技能市场',
        subTitle: '每项技能都是一个可插拔插件；已启用列表来自 DSH 插件清单。',
      }}
    >
      <div className="skills-stack">
        <Card className="skills-hero" variant="borderless">
          <div>
            <Tag className="skills-hero-tag" bordered={false} color="cyan">
              通用平台
            </Tag>
            <Title level={4} className="skills-hero-title">
              消息通道、记忆、红线与知识问答，都以插件形式工作
            </Title>
            <Paragraph className="skills-hero-desc">
              机构可以按服务包启用能力；卸载某个 zhiban 插件后，对应技能卡会变为未启用。
              控制台只展示清单，不在这里直接改 DSH 配置。
            </Paragraph>
          </div>
          <div className="skills-hero-points">
            <span>插件化</span>
            <span>可审计</span>
            <span>可组合</span>
          </div>
        </Card>

        <Card className="zb-card" variant="borderless" title="已启用技能" extra={<Text type="secondary">来自 DSH 插件清单</Text>}>
          {loading ? (
            <div className="skills-loading">
              <Spin />
              <span className="zb-muted">正在读取插件清单…</span>
            </div>
          ) : data && data.installed.length > 0 ? (
            <div className="skills-grid">
              {data.installed.map((skill) => (
                <Card
                  key={skill.id}
                  className="skill-card"
                  hoverable
                  onClick={() => setDetail(skill)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') setDetail(skill);
                  }}
                >
                  <div className={`skill-icon skill-icon-${tintFor(skill)}`}>{iconFor(skill)}</div>
                  <div className="skill-card-head">
                    <Text strong className="skill-name">
                      {skill.name}
                    </Text>
                    <Tag color="green" bordered={false}>
                      已启用
                    </Tag>
                  </div>
                  <Paragraph type="secondary" className="skill-desc">
                    {skill.description}
                  </Paragraph>
                  <div className="skill-card-foot">
                    <Tag bordered={false}>v{skill.version ?? '—'}</Tag>
                    <Text type="secondary" className="skill-plugin-id">
                      {skill.pluginId}
                    </Text>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Empty description="没有检测到已启用的 zhiban 插件" />
          )}
        </Card>

        <Card className="zb-card" variant="borderless" title="即将上线" extra={<Text type="secondary">C 档 · 随方案包开通</Text>}>
          <div className="skills-grid">
            {(data?.upcoming ?? []).map((skill) => (
              <Card
                key={skill.id}
                className="skill-card skill-card-upcoming"
                hoverable
                onClick={() => navigate(`/skills/${skill.id}`)}
                tabIndex={0}
                role="button"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') navigate(`/skills/${skill.id}`);
                }}
              >
                <div className="skill-icon skill-icon-slate">
                  <RocketOutlined />
                </div>
                <div className="skill-card-head">
                  <Text strong className="skill-name">
                    {skill.name}
                  </Text>
                  <Tag bordered={false} color="gold">
                    即将上线
                  </Tag>
                </div>
                <Paragraph type="secondary" className="skill-desc">
                  {skillBlurb(skill.id, skill.description)}
                </Paragraph>
                <div className="skill-card-foot">
                  <Text type="secondary">点击查看介绍与开通方式</Text>
                </div>
              </Card>
            ))}
          </div>
        </Card>
      </div>

      <Drawer
        title={detail?.name ?? '技能详情'}
        width={430}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        extra={detail ? <Tag color="green" bordered={false}>已启用</Tag> : null}
      >
        {detail ? (
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            <div className={`skill-icon skill-icon-${tintFor(detail)} skill-icon-large`}>{iconFor(detail)}</div>
            <Paragraph type="secondary" style={{ margin: 0 }}>
              {detail.description}
            </Paragraph>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="技能 ID">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="插件 ID">{detail.pluginId ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="版本">{detail.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="档位">{detail.tier} 档</Descriptions.Item>
              <Descriptions.Item label="能力">
                <Space size={[4, 4]} wrap>
                  {detail.capabilities.map((capability) => (
                    <Tag key={capability} bordered={false}>
                      {capability}
                    </Tag>
                  ))}
                </Space>
              </Descriptions.Item>
            </Descriptions>
            <div className="zb-note">
              真实环境中，卸载对应的 zhiban 插件后，这张卡片会变为未启用；控制台不提供直接卸载操作。
            </div>
          </Space>
        ) : null}
      </Drawer>
    </PageContainer>
  );
}
