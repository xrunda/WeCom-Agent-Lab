import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

/**
 * 侧边栏独立构建（#145）。
 *
 * 与控制台分开打包：不引入 React / Ant Design，产物控制在几百 KB 以内。
 * 页面根是 console/src/sidebar，产物输出到 console/dist-sidebar，
 * nginx 以 /sidebar/ 对外提供。
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/sidebar', import.meta.url)),
  base: '/sidebar/',
  build: {
    outDir: fileURLToPath(new URL('./dist-sidebar', import.meta.url)),
    emptyOutDir: true,
    target: 'es2019',
    rollupOptions: {
      input: fileURLToPath(new URL('./src/sidebar/index.html', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/zhiban/sidebar': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:3080',
        changeOrigin: true,
      },
    },
  },
});
