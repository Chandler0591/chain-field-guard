// =============================================================================
// AI 异常检测服务(链下智能)单元测试 —— 无需 Fabric 网络/IPFS,直接验证
// 规则引擎的评分、异常标记、等级映射、报告构造,以及可插拔引擎(provider)
// 的选择与降级容错。
//
// 运行方式:
//   cd backend && npm test(或直接:npm run test:unit)
//
// 覆盖维度:
//   1. 全部指标正常 → 0 分 NORMAL 无异常项;
//   2. 农残/铅两级阈值与水分区间边界(命中记分 + 异常标记);
//   3. 多项命中累加与总分封顶(100);
//   4. riskLevelOf 等级映射边界(29/30/59/60);
//   5. details 结构化明细(指标/检测值/单位/得分/档位);
//   6. buildReport 报告含输入/阈值/结论/引擎/模型版本(监管追溯依据);
//   7. provider 工厂按配置选择引擎(rule/http);
//   8. HttpModelProvider 正常解析 / 非 2xx 降级 / 超时降级 / 非法响应降级 / 评分越界收敛;
//   9. 降级结果标注 degradedFrom 且与规则引擎结果一致(回归)。
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  analyzeWithRules,
  analyze,
  riskLevelOf,
  buildReport,
  ruleEngineProvider,
  createProvider,
  createHttpModelProvider,
  analyzeWithProvider,
} from '../../src/services/ai.js';

/** 一份各项指标均合格的样本 */
const CLEAN_SAMPLE = { pesticideResidue: 0.001, heavyMetalPb: 0.01, moisturePct: 10 };

// ---------------------------------------------------------------------------
// 1. 规则引擎评分与异常标记
// ---------------------------------------------------------------------------

test('规则引擎:全部指标正常 → 0 分 NORMAL,无异常项', () => {
  const r = analyzeWithRules(CLEAN_SAMPLE);
  assert.equal(r.riskScore, 0);
  assert.equal(riskLevelOf(r.riskScore), 'NORMAL');
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.details, []);
});

test('规则引擎:农残达到警示阈值(0.02 mg/kg)→ 30 分,标记"农药残留超标"', () => {
  const r = analyzeWithRules({ ...CLEAN_SAMPLE, pesticideResidue: 0.02 });
  assert.equal(r.riskScore, 30);
  assert.equal(riskLevelOf(r.riskScore), 'WARN');
  assert.deepEqual(r.flags, ['农药残留超标']);
  assert.equal(r.details.length, 1);
});

test('规则引擎:农残达到严重阈值(0.15 mg/kg)→ 60 分,标记"严重超标"', () => {
  const r = analyzeWithRules({ ...CLEAN_SAMPLE, pesticideResidue: 0.15 });
  assert.equal(r.riskScore, 60);
  assert.equal(riskLevelOf(r.riskScore), 'HIGH');
  assert.deepEqual(r.flags, ['农药残留严重超标']);
});

test('规则引擎:铅达到警示阈值(0.15 mg/kg)→ 30 分,标记"重金属铅超标"', () => {
  const r = analyzeWithRules({ ...CLEAN_SAMPLE, heavyMetalPb: 0.15 });
  assert.equal(r.riskScore, 30);
  assert.deepEqual(r.flags, ['重金属铅超标']);
});

test('规则引擎:水分超出合理区间(过低 4% / 过高 25%)→ 20 分,标记异常;区间内不加分', () => {
  const low = analyzeWithRules({ ...CLEAN_SAMPLE, moisturePct: 4 });
  assert.equal(low.riskScore, 20);
  assert.deepEqual(low.flags, ['水分含量异常']);

  const high = analyzeWithRules({ ...CLEAN_SAMPLE, moisturePct: 25 });
  assert.equal(high.riskScore, 20);
  assert.deepEqual(high.flags, ['水分含量异常']);

  const boundary = analyzeWithRules({ ...CLEAN_SAMPLE, moisturePct: 5 }); // 下边界合法
  assert.equal(boundary.riskScore, 0);
});

test('规则引擎:多项命中累加(农残严重 + 铅警示)→ 60+30=90 分,两条异常项', () => {
  const r = analyzeWithRules({ ...CLEAN_SAMPLE, pesticideResidue: 0.15, heavyMetalPb: 0.15 });
  assert.equal(r.riskScore, 90);
  assert.equal(riskLevelOf(r.riskScore), 'HIGH');
  assert.equal(r.flags.length, 2);
  assert.deepEqual(r.flags, ['农药残留严重超标', '重金属铅超标']);
});

test('规则引擎:总分封顶(农残严重 + 铅严重 + 水分异常)→ 100 分', () => {
  const r = analyzeWithRules({ pesticideResidue: 0.2, heavyMetalPb: 0.3, moisturePct: 30 });
  assert.equal(r.riskScore, 100, '60+60+20 应封顶为 100');
  assert.equal(riskLevelOf(r.riskScore), 'HIGH');
});

// ---------------------------------------------------------------------------
// 2. 风险等级映射边界(必须与链码 riskLevelOf 一致)
// ---------------------------------------------------------------------------

test('风险等级映射边界:29→NORMAL,30→WARN,59→WARN,60→HIGH', () => {
  assert.equal(riskLevelOf(0), 'NORMAL');
  assert.equal(riskLevelOf(29), 'NORMAL');
  assert.equal(riskLevelOf(30), 'WARN');
  assert.equal(riskLevelOf(59), 'WARN');
  assert.equal(riskLevelOf(60), 'HIGH');
  assert.equal(riskLevelOf(100), 'HIGH');
});

// ---------------------------------------------------------------------------
// 3. 分析入口与报告构造(监管追溯依据)
// ---------------------------------------------------------------------------

test('analyze 入口:返回结构 { riskScore, flags, details }(供链上存证使用)', async () => {
  const r = await analyze({ ...CLEAN_SAMPLE, pesticideResidue: 0.02 });
  assert.equal(typeof r.riskScore, 'number');
  assert.ok(Array.isArray(r.flags));
  assert.ok(Array.isArray(r.details));
});

test('buildReport:报告含输入数据/阈值/结论/模型版本,JSON 可解析(监管可追溯)', () => {
  const sample = { origin: '山东寿光', produceType: '叶菜类', ...CLEAN_SAMPLE, pesticideResidue: 0.02 };
  const analysis = analyzeWithRules(sample);
  const report = buildReport('B001', sample, analysis, 'rule-engine-v1', '2026-09-30T10:00:00Z');

  const parsed = JSON.parse(report);
  assert.equal(parsed.type, 'AI_PRE_CHECK_REPORT');
  assert.equal(parsed.batchId, 'B001');
  assert.equal(parsed.modelVersion, 'rule-engine-v1');
  assert.equal(parsed.analyzedAt, '2026-09-30T10:00:00Z');
  assert.deepEqual(parsed.input, sample, '报告必须保留输入数据快照');
  assert.ok(parsed.thresholds.pesticideResidue, '报告必须保留判定阈值');
  assert.equal(parsed.result.riskScore, 30);
  assert.equal(parsed.result.riskLevel, 'WARN');
  assert.deepEqual(parsed.result.flags, ['农药残留超标']);
  assert.equal(parsed.result.details.length, 1);
});

// ---------------------------------------------------------------------------
// 4. details 结构化明细(供前端逐项展示与报告追溯)
// ---------------------------------------------------------------------------

test('规则引擎:details 为结构化明细(指标/检测值/单位/得分/档位)', () => {
  const r = analyzeWithRules({ pesticideResidue: 0.02, heavyMetalPb: 0.01, moisturePct: 10 });
  const d = r.details[0];
  assert.deepEqual(Object.keys(d).sort(), ['level', 'metric', 'score', 'unit', 'value'].sort());
  assert.equal(d.metric, '农药残留');
  assert.equal(d.value, 0.02);
  assert.equal(d.unit, 'mg/kg');
  assert.equal(d.score, 30);
  assert.equal(d.level, '超标');
});

test('buildReport:降级分析时报告包含 degraded 标注(可追溯降级原因)', () => {
  const analysis = {
    riskScore: 30,
    flags: ['农药残留超标'],
    details: [],
    providerName: 'rule-engine',
    degradedFrom: 'http-model',
    degradedReason: '模型服务响应异常: HTTP 500',
  };
  const report = buildReport('B001', CLEAN_SAMPLE, analysis, 'rule-engine-v1(降级:模型服务不可用)');
  const parsed = JSON.parse(report);
  assert.equal(parsed.provider, 'rule-engine');
  assert.equal(parsed.degraded.from, 'http-model');
  assert.equal(parsed.degraded.reason, '模型服务响应异常: HTTP 500');
});

// ---------------------------------------------------------------------------
// 5. 可插拔引擎(provider):工厂选择 / 正常解析 / 降级容错
// ---------------------------------------------------------------------------

/** 启动本地 HTTP mock 服务(随机端口),返回 { server, port } */
function startHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 统一关闭 mock 服务(closeAllConnections 防止超时用例残留连接导致卡住) */
function closeHttpServer(server) {
  server.closeAllConnections?.();
  server.close();
}

test('provider 工厂:默认与 rule → 规则引擎;http → HTTP 模型 provider', () => {
  assert.equal(createProvider({}).name, 'rule-engine');
  assert.equal(createProvider({ aiProvider: 'rule' }).name, 'rule-engine');
  const p = createProvider({ aiProvider: 'http', aiModelUrl: 'http://127.0.0.1:1/analyze', aiModelTimeoutMs: 100 });
  assert.equal(p.name, 'http-model');
});

test('规则引擎 provider:结果与 analyzeWithRules 完全一致(回归)', async () => {
  const s = { pesticideResidue: 0.15, heavyMetalPb: 0.15, moisturePct: 10 };
  const a = analyzeWithRules(s);
  const b = await ruleEngineProvider.analyze(s);
  assert.equal(b.riskScore, a.riskScore);
  assert.deepEqual(b.flags, a.flags);
  assert.deepEqual(b.details, a.details);
  assert.equal(b.providerName, 'rule-engine');
});

test('analyzeWithProvider:注入自定义 provider 执行分析(单测注入点)', async () => {
  const fake = {
    name: 'fake',
    async analyze() {
      return { riskScore: 42, flags: ['x'], details: [], providerName: 'fake' };
    },
  };
  const r = await analyzeWithProvider(CLEAN_SAMPLE, fake);
  assert.equal(r.riskScore, 42);
});

test('HTTP provider:模型服务正常响应 → 解析评分/异常项/模型版本,不降级', async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      riskScore: 70,
      flags: ['疑似高农药残留'],
      details: [{ metric: '农药残留', value: 0.15, unit: 'mg/kg', score: 70, level: '高风险' }],
      modelVersion: 'mock-ml-v1',
    }));
  });
  try {
    const p = createHttpModelProvider({ url: `http://127.0.0.1:${port}/analyze` });
    const r = await p.analyze({ pesticideResidue: 0.15, heavyMetalPb: 0.01, moisturePct: 10 });
    assert.equal(r.providerName, 'http-model');
    assert.equal(r.riskScore, 70);
    assert.equal(r.modelVersion, 'mock-ml-v1', '模型侧版本应透传(上链留痕)');
    assert.deepEqual(r.flags, ['疑似高农药残留']);
    assert.equal(r.degradedFrom, undefined, '服务正常时不应降级');
  } finally {
    closeHttpServer(server);
  }
});

test('HTTP provider:服务返回 500 → 降级规则引擎并标注 degradedFrom', async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  try {
    const p = createHttpModelProvider({ url: `http://127.0.0.1:${port}/analyze` });
    const r = await p.analyze({ pesticideResidue: 0.02, heavyMetalPb: 0.01, moisturePct: 10 });
    assert.equal(r.degradedFrom, 'http-model', '失败必须标注降级来源');
    assert.equal(r.providerName, 'rule-engine');
    assert.equal(r.riskScore, 30, '降级后应得到规则引擎的评分(0.02 农残 → 警示档)');
    assert.deepEqual(r.flags, ['农药残留超标']);
  } finally {
    closeHttpServer(server);
  }
});

test('HTTP provider:服务超时(不响应)→ 降级规则引擎', async () => {
  const { server, port } = await startHttpServer(() => { /* 故意不响应,触发超时 */ });
  try {
    const p = createHttpModelProvider({ url: `http://127.0.0.1:${port}/analyze`, timeoutMs: 150 });
    const r = await p.analyze({ pesticideResidue: 0.15, heavyMetalPb: 0.01, moisturePct: 10 });
    assert.equal(r.degradedFrom, 'http-model');
    assert.equal(r.riskScore, 60, '降级后应得到规则引擎的评分(0.15 农残 → 严重档)');
  } finally {
    closeHttpServer(server);
  }
});

test('HTTP provider:响应非法(非 JSON)→ 降级规则引擎', async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not-json');
  });
  try {
    const p = createHttpModelProvider({ url: `http://127.0.0.1:${port}/analyze` });
    const r = await p.analyze({ pesticideResidue: 0.02, heavyMetalPb: 0.01, moisturePct: 10 });
    assert.equal(r.degradedFrom, 'http-model');
    assert.equal(r.riskScore, 30);
  } finally {
    closeHttpServer(server);
  }
});

test('HTTP provider:模型返回非法评分 → 收敛到 0-100(0→0,250→100)', async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ riskScore: 250, flags: [], details: [] }));
  });
  try {
    const p = createHttpModelProvider({ url: `http://127.0.0.1:${port}/analyze` });
    const r = await p.analyze(CLEAN_SAMPLE);
    assert.equal(r.riskScore, 100, '超界评分应收敛到上限');
  } finally {
    closeHttpServer(server);
  }
});

test('HTTP provider:模型返回缺失/非法 riskScore → 降级规则引擎', async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ flags: [] })); // 缺 riskScore
  });
  try {
    const p = createHttpModelProvider({ url: `http://127.0.0.1:${port}/analyze` });
    const r = await p.analyze(CLEAN_SAMPLE);
    assert.equal(r.degradedFrom, 'http-model');
    assert.equal(r.riskScore, 0);
  } finally {
    closeHttpServer(server);
  }
});

// ---------------------------------------------------------------------------
// 6. 扩展检测维度(菌落总数 / 亚硝酸盐):两档阈值边界与可选字段兼容
// ---------------------------------------------------------------------------

test('规则引擎:菌落总数两档阈值(1e6 警示 30 分,1e7 严重 60 分)', () => {
  const warn = analyzeWithRules({ ...CLEAN_SAMPLE, totalBacteria: 1e6 });
  assert.equal(warn.riskScore, 30);
  assert.deepEqual(warn.flags, ['菌落总数超标']);
  assert.equal(warn.details[0].metric, '菌落总数');
  assert.equal(warn.details[0].unit, 'CFU/g');

  const high = analyzeWithRules({ ...CLEAN_SAMPLE, totalBacteria: 1e7 });
  assert.equal(high.riskScore, 60);
  assert.deepEqual(high.flags, ['菌落总数严重超标']);
});

test('规则引擎:亚硝酸盐两档阈值(2 警示 30 分,20 严重 60 分)', () => {
  const warn = analyzeWithRules({ ...CLEAN_SAMPLE, nitrite: 2 });
  assert.equal(warn.riskScore, 30);
  assert.deepEqual(warn.flags, ['亚硝酸盐超标']);

  const high = analyzeWithRules({ ...CLEAN_SAMPLE, nitrite: 20 });
  assert.equal(high.riskScore, 60);
  assert.deepEqual(high.flags, ['亚硝酸盐严重超标']);
});

test('规则引擎:新旧维度组合评分(农残严重 60 + 菌落警示 30 → 90 分)', () => {
  const r = analyzeWithRules({
    ...CLEAN_SAMPLE,
    pesticideResidue: 0.15,
    totalBacteria: 1e6,
  });
  assert.equal(r.riskScore, 90);
  assert.equal(riskLevelOf(r.riskScore), 'HIGH');
  assert.deepEqual(r.flags, ['农药残留严重超标', '菌落总数超标']);
});

test('规则引擎:菌落总数/亚硝酸盐缺省(不传)→ 不报错、不参与评分', () => {
  // 只传必填三字段(与旧版请求体兼容)
  const r = analyzeWithRules({ ...CLEAN_SAMPLE });
  assert.equal(r.riskScore, 0);
  assert.deepEqual(r.flags, []);

  // 可选维度传 null/undefined 也不应参与评分
  const r2 = analyzeWithRules({ ...CLEAN_SAMPLE, totalBacteria: null, nitrite: undefined });
  assert.equal(r2.riskScore, 0);
});
