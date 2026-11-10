import type { ReactNode } from 'react';

/**
 * 数据面板：一块细线围合的区域，只在需要承载一组数据时使用。
 * 页面上不再给每个区块都加卡片阴影。
 */
export function Panel({
  title,
  count,
  hint,
  extra,
  children,
  className,
  bodyClassName,
  flush = false,
}: {
  title: ReactNode;
  count?: ReactNode;
  hint?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
}) {
  return (
    <section className={['zb-panel', flush ? 'zb-panel-flush' : '', className].filter(Boolean).join(' ')}>
      <header className="zb-panel-head">
        <h2 className="zb-panel-title">
          {title}
          {count ? <span className="zb-panel-count">{count}</span> : null}
        </h2>
        {hint ? <span className="zb-panel-hint">{hint}</span> : null}
        {extra ? <div className="zb-panel-extra">{extra}</div> : null}
      </header>
      <div className={['zb-panel-body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
    </section>
  );
}
