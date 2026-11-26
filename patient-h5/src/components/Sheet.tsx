/**
 * 底部弹层：原生 <dialog> 包装。
 *
 * 用原生模态而不是自建遮罩，浏览器直接提供：页面 inert、焦点陷阱与归还、
 * top layer、::backdrop、Esc 与移动端返回手势关闭。
 * 点击外部关闭用 `closedby="any"`（Safari 缺失时降级为只支持 Esc，指南认可）。
 *
 * jsdom 没有 showModal，测试环境退化为设置 open 属性。
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Sheet({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 无障碍名称（对应标题） */
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      {...({ closedby: 'any' } as Record<string, string>)}
      onClose={onClose}
    >
      {children}
    </dialog>
  );
}
