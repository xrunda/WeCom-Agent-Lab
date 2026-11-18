import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icons';

interface ScreenshotProps {
  src: string;
  alt: string;
  caption?: string;
  className?: string;
  zoomable?: boolean;
}

/** 白底、细边线、12px 圆角的截图框（issue 视觉规格）。 */
export function Screenshot({ src, alt, caption = '产品界面 · 演示数据', className = '', zoomable = true }: ScreenshotProps) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <figure className={`shot ${className}`}>
        <button
          ref={triggerRef}
          type="button"
          className="shot__button"
          onClick={() => zoomable && setOpen(true)}
          aria-label={zoomable ? `放大查看：${alt}` : undefined}
          tabIndex={zoomable ? 0 : -1}
        >
          <img src={src} alt={alt} loading="lazy" />
        </button>
        {caption ? (
          <figcaption className="shot__caption">
            <span className="shot__dot" aria-hidden="true" />
            {caption}
          </figcaption>
        ) : null}
      </figure>

      {open ? (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={() => setOpen(false)}>
          <button
            ref={closeRef}
            type="button"
            className="lightbox__close"
            onClick={() => setOpen(false)}
            aria-label="关闭放大查看"
          >
            <Icon name="close" size={22} />
          </button>
          <img src={src} alt={alt} className="lightbox__image" onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}
    </>
  );
}
