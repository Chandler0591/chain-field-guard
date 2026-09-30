// =============================================================================
// 健康检查路由:GET /api/health
//
// 原理:以 operator 身份向链码查询一个必然不存在的批次
//   - 若返回的报错包含"不存在" → 说明网关连通、链码可达(健康);
//   - 若报错是连接类错误 → 网络未启动或证书路径错误(不健康)。
// 前端/联调时可先访问本接口确认"后端 → 链上"整条链路可用。
// =============================================================================

import { Router } from 'express';
import * as gateway from '../services/gateway.js';

const router = Router();

router.get('/health', async (req, res) => {
  try {
    // 查询一个必然不存在的批次:链码会抛出"批次 __health_probe__ 不存在"
    await gateway.evaluateTx('operator', 'GetBatch', '__health_probe__');
    return res.json({ ok: true, data: { status: 'healthy', detail: '网关与链码均可达' } });
  } catch (err) {
    const message = gateway.extractError(err);
    if (message.includes('不存在')) {
      // 能到达链码并得到业务错误 → 链路健康
      return res.json({ ok: true, data: { status: 'healthy', detail: '网关与链码均可达(探针批次不存在)' } });
    }
    // 连接类失败:提示用户检查网络是否已启动、钱包是否已初始化
    return res.status(503).json({
      ok: false,
      error: `链上链路不可用: ${message}。请确认:1) network 已 up 且链码已部署;2) 已执行 npm run setup-wallet`,
    });
  }
});

export default router;
