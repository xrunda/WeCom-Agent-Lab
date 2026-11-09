import { PageContainer } from '@ant-design/pro-components';

import { ComingSoonPage } from '../../components/ComingSoonPage.tsx';

export default function ShiftsPage() {
  return (
    <PageContainer header={{ title: '排班与交接' }}>
      <ComingSoonPage
        title="排班与交接"
        description="排班、交接班与工作量分配，让服务团队协作更顺畅。"
      />
    </PageContainer>
  );
}
