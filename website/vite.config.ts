/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
  plugins: [react(), robotsMeta()],
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
