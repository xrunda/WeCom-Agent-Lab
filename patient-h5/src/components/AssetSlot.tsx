/**
 * 素材占位（ASSET-INVENTORY 的 P01/P02/D01… 编号）。
 *
 * 正式素材按容器比例导出后替换本组件；在此之前用克制的渐变占位，
 * 不把整页概念图塞进页面（PRD §3.1）。`data-asset` 便于交付时对照清单。
 */
export function AssetSlot({
  id,
  ratio = '16 / 9',
  radius = 12,
  label,
  src,
  className = '',
}: {
  id: string;
  ratio?: string;
  radius?: number;
  label?: string;
  /** 已就位的素材地址；缺省时显示占位块 */
  src?: string;
  className?: string;
}) {
  if (src) {
    return (
      <img
        className={`asset-slot asset-media ${className}`}
        data-asset={id}
        src={src}
        alt={label ?? ''}
        style={{ aspectRatio: ratio, borderRadius: radius }}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <div
      className={`asset-slot ${className}`}
      data-asset={id}
      style={{ aspectRatio: ratio, borderRadius: radius }}
      role="img"
      aria-label={label ?? `素材占位 ${id}`}
    >
      <span className="asset-slot__tag">{id}</span>
    </div>
  );
}
