/**
 * 一级页面统一页头：眉标（农历等）→ 大标题 → 副标题。
 * 四个 tab 共用同一套间距与字号，避免每页各写一套。
 */
export function TabHeader({
  title,
  eyebrow,
  subtitle,
  size = 'page',
}: {
  title: string;
  /** 标题上方的小字，如农历与星期 */
  eyebrow?: string;
  subtitle?: string;
  /** brand：食养这类品牌级大标题；page：其余页面 */
  size?: 'page' | 'brand';
}) {
  return (
    <header className={`tab-head tab-head--${size}`}>
      {eyebrow && <p className="tab-head__eyebrow">{eyebrow}</p>}
      <h1 className="tab-head__title">{title}</h1>
      {subtitle && <p className="tab-head__sub">{subtitle}</p>}
    </header>
  );
}
