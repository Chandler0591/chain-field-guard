// =============================================================================
// Express 应用组装:加载中间件与各路由模块。
// 与 server.js 分离的目的:测试可以 import { createApp } 直接拿到 app,
// 用临时端口启动,不必经过真实监听 3000 端口。
// =============================================================================

import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import uploadRouter from './routes/upload.js';
import batchesRouter from './routes/batches.js';

export function createApp() {
  const app = express();

  // 跨域(前端 Vite 开发服务器端口与本服务不同,需放开 CORS)
  app.use(cors());

  // JSON 请求体解析(写接口的 body 参数)
  app.use(express.json({ limit: '2mb' }));

  // 简单请求日志(演示用):方法、路径、角色
  app.use((req, res, next) => {
    const role = req.query?.role ?? req.headers?.['x-role'] ?? '(默认 operator)';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} role=${role}`);
    next();
  });

  // 业务路由
  app.use('/api', healthRouter);
  app.use('/api', uploadRouter);
  app.use('/api', batchesRouter);

  // 统一兜底:未匹配到任何路由
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: `接口不存在: ${req.method} ${req.originalUrl}` });
  });

  // 统一错误处理(同步中间件抛错、multer 错误等都会走到这里)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[未捕获错误]', err);
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  });

  return app;
}
