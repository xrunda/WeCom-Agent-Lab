/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 本地 dev / preview 也要给纯文本补上 charset：浏览器对 `text/plain` 没有 charset
 * 时会按本地编码猜，中文会显示成乱码（生产由 nginx 显式设置）。
 */
function utf8TextFiles() {
  const handle = (root: string) => (req: { url?: string }, res: any, next: () => void) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/llms.txt' || url === '/robots.txt') {
      const file = join(root, url.slice(1));
      if (existsSync(file)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(readFileSync(file));
        return;
      }
    }
    next();
  };

  return {
    name: 'zhiban-utf8-text-files',
    configureServer(server: any) {
      server.middlewares.use(handle(join(process.cwd(), 'public')));
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(handle(join(process.cwd(), 'dist')));
    },
  };
}

/**
 * index.html 里静态写的是 noindex，运行时才按环境切换。爬虫不会执行 JS，
 * 所以构建时就要把 robots 元信息写对：预览保持 noindex，生产（配好域名）才放开。
 */
function robotsMeta() {
  return {
    name: 'zhiban-robots-meta',
    transformIndexHtml(html: string) {
      const origin = process.env.VITE_SITE_ORIGIN?.trim();
      const allow = process.env.VITE_ALLOW_INDEX === '1';
      const content = allow && origin ? 'index,follow' : 'noindex,nofollow';
      return html.replace(/<meta name="robots"[^>]*>/, `<meta name="robots" content="${content}">`);
    },
  };
}

export default defineConfig({
  plugins: [react(), robotsMeta(), utf8TextFiles()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
