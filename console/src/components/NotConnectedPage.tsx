import { Alert, Tag } from 'antd';

import { PageHeader } from './PageHeader.tsx';
import { Panel } from './Panel.tsx';

/**
 * 真实模式下，后端接口尚未接入的页面统一使用这个状态。
 * 目的：宁可显示「尚未接入」，也不把示例数据伪装成真实运营数据。
 */
export function NotConnectedPage({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="zb-page">
      <PageHeader
        title={title}
        tags={<Tag className="feature-status-tag">未接入</Tag>}
        description={description}
      />
      <Panel title="本页尚未接入真实接口">
        <Alert
          type="info"
          showIcon
          message="真实模式下不展示示例数据"
          description="该模块的后端接口尚未随 P1 部署。示例数据只在 MOCK 模式可见，避免与真实客户、真实群和真实草稿混淆。"
        />
      </Panel>
    </div>
  );
}
