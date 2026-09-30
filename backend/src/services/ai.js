// =============================================================================
// AI 异常检测服务(链下智能):分析批次的结构化检测数据,输出风险评分与异常项。
//
// 架构定位(链下智能 + 链上存证 + 人工决策,与 AI 异常检测设计一致):
//   - 链下:AI 分析在链下完成(本服务),不占用链上算力;完整报告存 IPFS,
//     链上只锚定报告 CID + SHA-256 与摘要结论(见链码 RecordAICheck);
//   - 链上:分析报告的哈希与摘要由链码存证,监管方可追溯
//     "AI 在什么时间、基于什么数据、用什么模型、做出什么判断";
//   - 人工:AI 结论是辅助证据,不改变批次状态机 —— 核对人签名前可查看
//     风险提示,自行决定继续签名或发起修改,最终决策权在人工与链上规则。
//
// 引擎可插拔(provider 模式,通过 AI_PROVIDER=rule|http 切换):
//   - RuleEngineProvider(默认):内置阈值规则引擎,离线可用、结果确定、可直接单测;
//   - HttpModelProvider:POST 调用外部模型服务(AI_MODEL_URL),解析
//     { riskScore, flags, details } 响应;请求失败(超时/非 2xx/响应非法)时
//     自动降级回退规则引擎,并在结果中标注 degradedFrom —— 链上存证格式
//     与链码无需任何改动,历史报告与存证完全兼容。
// =============================================================================

// ---------------------------------------------------------------------------
// 风险阈值(演示用参考值,可按实际检验标准调整)
//   kind=ge 的指标分两级阈值:≥ high 记 60 分,≥ warn 记 30 分;
//   kind=range 的指标:超出合理区间 [low, high] 记 20 分。
// ---------------------------------------------------------------------------
const THRESHOLDS = {
  pesticideResidue: { kind: 'ge', warn: 0.01, high: 0.1, unit: 'mg/kg', label: '农药残留' },
  heavyMetalPb: { kind: 'ge', warn: 0.1, high: 0.2, unit: 'mg/kg', label: '重金属铅' },
  moisturePct: { kind: 'range', low: 5, high: 20, unit: '%', label: '水分含量' },
  totalBacteria: { kind: 'ge', warn: 1e6, high: 1e7, unit: 'CFU/g', label: '菌落总数' },
  nitrite: { kind: 'ge', warn: 2, high: 20, unit: 'mg/kg', label: '亚硝酸盐' },
};

/**
 * 风险分 → 风险等级映射。
 * 注意:此规则必须与链码 riskLevelOf 完全一致(链上以分值为唯一权威,
 * 等级由链码派生写入,本函数仅用于本地报告展示,避免前后端口径不一致)。
 *   0-29 NORMAL(正常)/ 30-59 WARN(关注)/ 60-100 HIGH(高风险)
 * @param {number} score 风险评分
 * @returns {'NORMAL'|'WARN'|'HIGH'}
 */
export function riskLevelOf(score) {
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'WARN';
  return 'NORMAL';
}

/**
 * 规则引擎:按阈值逐项检查结构化检测数据,累加风险分并生成异常项标记。
 * 评分规则(命中多项可累加,总分封顶 100;同一指标只按最高命中档计一次):
 *   - 农药残留 ≥ 0.1 mg/kg 记 60 分,≥ 0.01 mg/kg 记 30 分;
 *   - 重金属铅 ≥ 0.2 mg/kg 记 60 分,≥ 0.1 mg/kg 记 30 分;
 *   - 水分含量超出 5%~20% 合理区间记 20 分;
 *   - 菌落总数 ≥ 1e7 CFU/g 记 60 分,≥ 1e6 CFU/g 记 30 分;
 *   - 亚硝酸盐 ≥ 20 mg/kg 记 60 分,≥ 2 mg/kg 记 30 分;
 *   - 菌落总数/亚硝酸盐为可选字段:未提供(undefined)时跳过,不参与评分。
 * @param {object} sample 结构化检测数据(字段见 routes/batches.js ai-check 接口)
 * @returns {{riskScore:number, flags:string[], details:Array<{metric,value,unit,score,level}>}}
 *   风险分、异常项、判定明细(结构化对象数组,便于前端逐项展示与报告追溯)
 */
export function analyzeWithRules(sample) {
  let score = 0;
  const flags = [];
  const details = [];

  // ---- 两级阈值指标(ge 类):循环统一处理,新增维度只需在 THRESHOLDS 加一行 ----
  for (const [field, t] of [
    ['pesticideResidue', THRESHOLDS.pesticideResidue],
    ['heavyMetalPb', THRESHOLDS.heavyMetalPb],
    ['totalBacteria', THRESHOLDS.totalBacteria],
    ['nitrite', THRESHOLDS.nitrite],
  ]) {
    const v = sample[field];
    // 可选维度未提供时跳过(必填维度由路由层校验,这里同样防御性跳过)
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v >= t.high) {
      score += 60;
      flags.push(`${t.label}严重超标`);
      details.push({ metric: t.label, value: v, unit: t.unit, score: 60, level: '严重超标' });
    } else if (v >= t.warn) {
      score += 30;
      flags.push(`${t.label}超标`);
      details.push({ metric: t.label, value: v, unit: t.unit, score: 30, level: '超标' });
    }
  }

  // ---- 水分含量(超出合理区间记 20 分)----
  const m = sample.moisturePct;
  if (typeof m === 'number' && Number.isFinite(m)) {
    if (m < THRESHOLDS.moisturePct.low || m > THRESHOLDS.moisturePct.high) {
      score += 20;
      flags.push(`${THRESHOLDS.moisturePct.label}异常`);
      details.push({
        metric: THRESHOLDS.moisturePct.label, value: m, unit: THRESHOLDS.moisturePct.unit,
        score: 20, level: '超出合理区间',
      });
    }
  }

  return { riskScore: Math.min(score, 100), flags, details };
}

// ---------------------------------------------------------------------------
// Provider 契约:async analyze(sample) → { riskScore, flags, details, ... }
//   - riskScore:number(0-100)  风险评分
//   - flags:string[]            异常项标记(随交易上链)
//   - details:对象数组           判定明细(进 IPFS 报告,便于追溯与前端展示)
//   - providerName:string       引擎标识(报告留痕,可追溯"用的哪个引擎")
//   - modelVersion?:string      模型版本(http provider 成功时返回)
//   - degradedFrom?:string      降级来源(模型服务不可用时回退规则引擎)
// ---------------------------------------------------------------------------

/**
 * 内置规则引擎 provider(默认):离线可用、结果确定,是 http provider 的降级兜底。
 */
export const ruleEngineProvider = {
  name: 'rule-engine',
  async analyze(sample) {
    return { ...analyzeWithRules(sample), providerName: 'rule-engine' };
  },
};

/**
 * 带超时的 JSON POST 请求(Node 18+ 全局 fetch,用 AbortController 实现超时)。
 * @param {string} url     模型服务地址
 * @param {object} sample  请求体(结构化检测数据)
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<Response>}
 */
async function postJsonWithTimeout(url, sample, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 评分越界保护:模型返回非法分值时收敛到 0-100 区间 */
function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`非法评分: ${v}`);
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 创建 HTTP 模型 provider:POST 调用外部模型服务(AI_MODEL_URL)。
 * 模型服务约定返回 { riskScore, flags?:string[], details?:object[], modelVersion?:string };
 * 请求失败(超时/非 2xx/响应非法)时自动降级回退到 fallbackProvider(默认规则引擎),
 * 降级结果会带 degradedFrom 字段,报告 modelVersion 中标注降级来源。
 * @param {object} opts
 * @param {string} opts.url 模型服务地址(如 http://127.0.0.1:3100/analyze)
 * @param {number} [opts.timeoutMs] 超时毫秒数(默认 3000)
 * @param {object} [opts.fallbackProvider] 降级兜底 provider(默认规则引擎)
 * @param {string} [opts.modelVersion] 模型版本(成功且服务未返回版本时使用)
 */
export function createHttpModelProvider({
  url, timeoutMs = 3000, fallbackProvider = ruleEngineProvider, modelVersion = 'http-model-v1',
}) {
  return {
    name: 'http-model',
    modelVersion,
    async analyze(sample) {
      try {
        const res = await postJsonWithTimeout(url, sample, timeoutMs);
        if (!res.ok) throw new Error(`模型服务响应异常: HTTP ${res.status}`);
        const data = await res.json();
        // 归一化模型响应为统一结构,字段非法则视为响应非法并降级
        const r = {
          riskScore: clampScore(data.riskScore),
          flags: Array.isArray(data.flags) ? data.flags.map(String) : [],
          details: Array.isArray(data.details) ? data.details : [],
          providerName: 'http-model',
          modelVersion: data.modelVersion ?? this.modelVersion,
        };
        return r;
      } catch (err) {
        // 降级:回退规则引擎,并标注降级来源与原因(写入报告,可追溯)
        const fb = await fallbackProvider.analyze(sample);
        return {
          ...fb,
          degradedFrom: 'http-model',
          degradedReason: String(err?.message ?? err),
        };
      }
    },
  };
}

/**
 * Provider 工厂:按配置选择引擎(AI_PROVIDER=rule|http)。
 * @param {{aiProvider?:string, aiModelUrl?:string, aiModelTimeoutMs?:number}} cfg
 */
export function createProvider(cfg) {
  if (cfg.aiProvider === 'http') {
    return createHttpModelProvider({
      url: cfg.aiModelUrl,
      timeoutMs: cfg.aiModelTimeoutMs,
    });
  }
  return ruleEngineProvider;
}

/**
 * 用指定 provider 执行分析(便于单测注入;生产路径由 analyze 统一入口调用)。
 */
export async function analyzeWithProvider(sample, provider) {
  return provider.analyze(sample);
}

/**
 * AI 分析统一入口:默认使用内置规则引擎(无外部依赖,离线可用)。
 * 需要对接真实模型时,由调用方注入 provider(见 createProvider 与 routes/batches.js):
 *   const provider = createProvider(config);        // AI_PROVIDER=rule|http
 *   const result = await analyze(sample, provider); // http 模式失败自动降级
 * 返回结构:{ riskScore, flags, details, providerName, modelVersion?, degradedFrom? }
 * @param {object} sample 结构化检测数据
 * @param {object} [provider] 分析引擎(默认内置规则引擎)
 */
export async function analyze(sample, provider = ruleEngineProvider) {
  return analyzeWithProvider(sample, provider);
}

/**
 * 构造 AI 预检完整报告(上传 IPFS 留档,链上只锚定其哈希):
 * 包含输入数据、判定阈值、分析结论、引擎与模型版本 —— 保证监管方可追溯
 * "AI 基于什么数据(输入+阈值)、用哪个引擎/模型(版本)、做出什么判断(评分+异常项+明细)"。
 * @param {string} batchId 批次号
 * @param {object} sample  结构化检测数据(输入)
 * @param {{riskScore:number, flags:string[], details:object[]}} analysis 分析结论
 * @param {string} modelVersion 模型/规则引擎版本(降级时含降级标注)
 * @param {string} [analyzedAt] 分析时间(默认当前时间 ISO 格式)
 * @returns {string} 报告 JSON 字符串(格式化,便于人工审阅)
 */
export function buildReport(batchId, sample, analysis, modelVersion, analyzedAt = new Date().toISOString()) {
  return JSON.stringify(
    {
      type: 'AI_PRE_CHECK_REPORT',
      batchId,
      modelVersion,
      provider: analysis.providerName ?? 'unknown',
      analyzedAt,
      input: sample,
      thresholds: THRESHOLDS,
      result: {
        riskScore: analysis.riskScore,
        riskLevel: riskLevelOf(analysis.riskScore),
        flags: analysis.flags,
        details: analysis.details,
      },
      ...(analysis.degradedFrom
        ? { degraded: { from: analysis.degradedFrom, reason: analysis.degradedReason } }
        : {}),
    },
    null,
    2
  );
}
