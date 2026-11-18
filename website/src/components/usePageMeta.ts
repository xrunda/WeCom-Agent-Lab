import { useEffect } from 'react';

import { PAGE_META } from '../site';

/**
 * 每页独立标题与描述。预览默认 noindex（index.html 已声明），
 * 生产域名确定后通过 VITE_SITE_ORIGIN + VITE_ALLOW_INDEX 生成 canonical / sitemap。
 */
export function usePageMeta(path: string): void {
  useEffect(() => {
    const meta = PAGE_META[path] ?? PAGE_META['/'];
    document.title = meta.title;

    const setMeta = (name: string, content: string, attr: 'name' | 'property' = 'name') => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    setMeta('description', meta.description);
    setMeta('og:title', meta.title, 'property');
    setMeta('og:description', meta.description, 'property');

    const origin = import.meta.env.VITE_SITE_ORIGIN as string | undefined;
    const allowIndex = import.meta.env.VITE_ALLOW_INDEX === '1';
    setMeta('robots', allowIndex && origin ? 'index,follow' : 'noindex,nofollow');
    const ogImage = origin ? new URL('/assets/brand/zhiban-og.png', origin).toString() : '/assets/brand/zhiban-og.png';
    setMeta('og:image', ogImage, 'property');
    if (origin) setMeta('og:url', new URL(meta.path, origin).toString(), 'property');

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (origin) {
      if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
      }
      canonical.href = new URL(meta.path, origin).toString();
    } else if (canonical) {
      canonical.remove();
    }
  }, [path]);
}
