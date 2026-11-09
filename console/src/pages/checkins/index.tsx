import { PageContainer } from '@ant-design/pro-components';

import { ComingSoonPage } from '../../components/ComingSoonPage.tsx';

export default function CheckinsPage() {
  return (
    <PageContainer header={{ title: '健康打卡' }}>
      <ComingSoonPage
        title="健康打卡"
        description="打卡计划、提醒与依从性统计，帮助企业把服务延伸到日常。"
      />
    </PageContainer>
  );
}
