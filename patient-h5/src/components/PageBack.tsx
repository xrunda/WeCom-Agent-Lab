/**
 * 页面左上角返回。所有非 tab 页面都必须有一个，避免用户被困在流程里。
 */
export function PageBack({ onClick, label = '返回' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="link-btn page-back" onClick={onClick}>
      <span aria-hidden="true">‹</span> {label}
    </button>
  );
}
