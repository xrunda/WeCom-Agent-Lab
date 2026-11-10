import type { ReactNode } from 'react';

/** 页面标题区：标题、数据来源标签、一句话说明与右侧操作。 */
export function PageHeader({
  title,
  tags,
  description,
  actions,
}: {
  title: ReactNode;
  tags?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="zb-page-header">
      <div className="zb-page-header-main">
        <div className="zb-page-header-title-row">
          <h1 className="zb-page-header-title">{title}</h1>
          {tags}
        </div>
        {description ? <p className="zb-page-header-desc">{description}</p> : null}
      </div>
      {actions ? <div className="zb-page-header-actions">{actions}</div> : null}
    </div>
  );
}
