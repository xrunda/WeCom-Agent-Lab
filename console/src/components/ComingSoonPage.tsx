import { ArrowRightOutlined, ClockCircleOutlined, RocketOutlined } from '@ant-design/icons';
import { Button, Card, Result, Space, Steps, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';

const { Paragraph, Text } = Typography;

export interface ComingSoonPageProps {
  title: string;
  description: string;
}

/**
 * C 档页面统一介绍页：说明价值、给出示意、引导联系开通。
 * 所有「即将上线」入口都用这个组件，避免每个页面各写一套。
 */
export function ComingSoonPage({ title, description }: ComingSoonPageProps) {
  const navigate = useNavigate();

  return (
    <div className="coming-soon">
      <Result
        icon={<RocketOutlined />}
        title={`${title} · 即将上线`}
        subTitle={description}
        extra={
          <Space wrap>
            <Button type="primary" onClick={() => navigate('/settings/onboarding')}>
              联系开通 <ArrowRightOutlined />
            </Button>
            <Button onClick={() => navigate('/dashboard')}>返回工作台</Button>
          </Space>
        }
      >
        <Card className="coming-soon-card" variant="borderless">
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            <div className="coming-soon-badge">
              <ClockCircleOutlined /> 企业版能力 · 随服务包开通
            </div>
            <Steps
              responsive
              current={1}
              items={[
                { title: '申请开通', description: '在「开通正式服务」提交申请' },
                { title: '方案确认', description: '确认服务范围与席位' },
                { title: '上线使用', description: '配置完成后即可使用' },
              ]}
            />
            <Paragraph type="secondary" style={{ margin: 0 }}>
              这个页面已经预留了入口和路由。P1 只展示介绍与开通路径，具体功能在后续版本交付。
            </Paragraph>
            <Text type="secondary">
              需要提前体验？可以先去「体验中心（沙盒）」走一遍真实链路。
            </Text>
          </Space>
        </Card>
      </Result>
    </div>
  );
}
