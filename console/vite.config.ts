/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/zhiban/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:3080',
        changeOrigin: true,
        // 本地 dev 与生产同源部署不同：浏览器 Origin 是 127.0.0.1:5173，
        // 后端只允许配置里的来源。代理层去掉 Origin，按「无 Origin 的非浏览器请求」处理。
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
          });
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
  },
});
