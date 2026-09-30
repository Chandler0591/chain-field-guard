#!/usr/bin/env node
// =============================================================================
// 链田守护 · Mock AI 模型服务(演示用,零依赖,Node 18+ 直接运行)
//
// 作用:模拟一个"真实 AI 异常检测模型"的 HTTP 服务,配合后端可插拔引擎演示:
//   1) node scripts/mock-ai-model.js            # 启动(默认 3100 端口)
//   2) backend/.env 设 AI_PROVIDER=http
//   3) 重启后端,POST /api/batches/:id/ai-check 时后端调用本服务分析,
//      链上存证的 modelVersion 变为 mock-ml-v1(而非 rule-engine-v1)
//
// 模拟的"模型特征"(与规则引擎不同的表现,便于答辩演示差异):
//   - 农药残留 ≥ 0.15 记 70 分并标记"疑似高残留"(规则引擎给 60 分);
//   - 重金属铅 ≥ 0.1 记 40 分并标记"重金属铅偏高风险";
//   - 返回带模型置信度特征的明细与模型版本号。
//
// 运行方式(仓库根目录):
//   node scripts/mock-ai-model.js
//   或指定端口:PORT=3200 node scripts/mock-ai-model.js
// =============================================================================

const http = require('node:http');

const PORT = Number(process.env.PORT || 3100);
const MODEL_VERSION = 'mock-ml-v1';

/** 模拟模型分析:给出与规则引擎略有差异的评分与异常标记 */
function mockModelAnalyze(sample) {
  let score = 0;
  const flags = [];
  const details = [];

  // 模拟特征 1:农药残留 ≥ 0.15 → 70 分("模型"比规则引擎更敏感)
  if (sample.pesticideResidue >= 0.15) {
    score += 70;
    flags.push('疑似高农药残留');
    details.push({
      metric: '农药残留', value: sample.pesticideResidue, unit: 'mg/kg',
      score: 70, level: '模型判定高风险', confidence: 0.93,
    });
  } else if (sample.pesticideResidue >= 0.01) {
    score += 40;
    flags.push('农药残留偏高');
    details.push({
      metric: '农药残留', value: sample.pesticideResidue, unit: 'mg/kg',
      score: 40, level: '模型判定关注', confidence: 0.81,
    });
  }

  // 模拟特征 2:重金属铅 ≥ 0.1 → 40 分
  if (sample.heavyMetalPb >= 0.1) {
    score += 40;
    flags.push('重金属铅偏高风险');
    details.push({
      metric: '重金属铅', value: sample.heavyMetalPb, unit: 'mg/kg',
      score: 40, level: '模型判定关注', confidence: 0.77,
    });
  }

  // 模拟特征 3:水分异常 → 20 分(与规则引擎一致)
  if (sample.moisturePct < 5 || sample.moisturePct > 20) {
    score += 20;
    flags.push('水分含量异常');
    details.push({
      metric: '水分含量', value: sample.moisturePct, unit: '%',
      score: 20, level: '超出合理区间', confidence: 0.99,
    });
  }

  return {
    riskScore: Math.min(score, 100),
    flags,
    details,
    modelVersion: MODEL_VERSION,
  };
}

const server = http.createServer((req, res) => {
  // 只处理 POST /analyze
  if (req.method === 'POST' && req.url === '/analyze') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const sample = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(mockModelAnalyze(sample)));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求体必须为 JSON' }));
      }
    });
    return;
  }

  // 健康检查(便于脚本探测服务是否就绪)
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', modelVersion: MODEL_VERSION }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ai-model] Mock AI 模型服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`[mock-ai-model] 模型版本: ${MODEL_VERSION}(区别于规则引擎 rule-engine-v1)`);
  console.log('[mock-ai-model] 后端对接:backend/.env 设 AI_PROVIDER=http 后重启后端');
});
