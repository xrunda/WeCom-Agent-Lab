import { PageContainer } from '@ant-design/pro-components';
import { Card, Empty, Typography } from 'antd';

import { SampleDataTag } from './SampleDataTag.tsx';

const { Paragraph, Text } = Typography;

export interface PagePlaceholderProps {
  title: string;
  description: string;
  tier: 'A' | 'B' | 'C';
  /** 当前页面归属的工作包，方便 review 时确认占位页由谁替换 */
  owner?: string;
}

/**
 * 工作包 I 只负责外壳；业务页面内容由 J/K/L/M 在自己的目录里实现。
 * 占位页保持可点击、可构建，并明确标出数据档位。
 */
export function PagePlaceholder({ title, description, tier, owner }: PagePlaceholderProps) {
  return (
    <PageContainer
      header={{
        title,
        subTitle: description,
        extra: tier === 'B' ? [<SampleDataTag key="sample" />] : undefined,
      }}
    >
      <Card variant="borderless" className="placeholder-card">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <div>
              <Paragraph strong style={{ marginBottom: 4 }}>
                页面骨架已就绪
              </Paragraph>
              <Text type="secondary">
                业务内容由 {owner ?? '后续工作包'} 按 issue 实现；当前路由、菜单和档位标签已接好。
              </Text>
            </div>
          }
        />
      </Card>
    </PageContainer>
  );
}
