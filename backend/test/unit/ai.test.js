// =============================================================================
// AI 异常检测服务(链下智能)单元测试 —— 无需 Fabric 网络/IPFS,直接验证
// 规则引擎的评分、异常标记、等级映射与报告构造。
//
// 运行方式:
//   cd backend && npm test(或直接:npm run test:unit)
//
// 覆盖维度:
//   1. 全部指标正常 → 0 分 NORMAL 无异常项;
//   2. 农残/铅两级阈值与水分区间边界(命中记分 + 异常标记);
//   3. 多项命中累加与总分封顶(100);
//   4. riskLevelOf 等级映射边界(29/30/59/60);
//   5. buildReport 报告含输入/阈值/结论/模型版本(监管追溯的依据)。
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithRules, analyze, riskLevelOf, buildReport } from '../../src/services/ai.js';

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
