// =============================================================================
// Vite 配置:
//   1. 开发代理:前端请求 /api/** 转发到后端 http://127.0.0.1:3000,
//      避免跨域且代码里直接用相对路径;
//   2. 构建产物目录与常用 dev server 端口。
// =============================================================================

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 后端地址可通过环境变量覆盖(默认与 backend/.env.example 的 PORT=3000 一致)
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
