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
// 默认实现为规则引擎(阈值规则):离线可用、结果确定、可直接单测;
// 接入真实 AI 模型时,只需替换 analyze() 的实现(如调用模型 HTTP 服务),
// 保持返回结构不变即可 —— 链上存证格式与链码无需任何改动。
// =============================================================================

// 风险阈值(演示用参考值,可按实际检验标准调整):
//   - 农药残留/重金属铅:分两级阈值,命中高阈值记 60 分,低阈值记 30 分;
//   - 水分含量:超出合理区间 [low, high] 记 20 分。
const THRESHOLDS = {
  pesticideResidue: { warn: 0.01, high: 0.1, unit: 'mg/kg', label: '农药残留' },
  heavyMetalPb: { warn: 0.1, high: 0.2, unit: 'mg/kg', label: '重金属铅' },
  moisturePct: { low: 5, high: 20, unit: '%', label: '水分含量' },
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
 *   - 水分含量超出 5%~20% 合理区间记 20 分。
 * @param {object} sample 结构化检测数据(字段见 routes/batches.js ai-check 接口)
 * @returns {{riskScore:number, flags:string[], details:string[]}} 风险分、异常项、判定明细
 */
export function analyzeWithRules(sample) {
  let score = 0;
  const flags = [];
  const details = [];

  // ---- 农药残留(只按最高命中档计一次)----
  const pes = THRESHOLDS.pesticideResidue;
  if (sample.pesticideResidue >= pes.high) {
    score += 60;
    flags.push(`${pes.label}严重超标`);
    details.push(`${pes.label} ${sample.pesticideResidue} ${pes.unit} ≥ ${pes.high} ${pes.unit}(严重)`);
  } else if (sample.pesticideResidue >= pes.warn) {
    score += 30;
    flags.push(`${pes.label}超标`);
    details.push(`${pes.label} ${sample.pesticideResidue} ${pes.unit} ≥ ${pes.warn} ${pes.unit}`);
  }

  // ---- 重金属铅(同上,两级阈值)----
  const pb = THRESHOLDS.heavyMetalPb;
  if (sample.heavyMetalPb >= pb.high) {
    score += 60;
    flags.push(`${pb.label}严重超标`);
    details.push(`${pb.label} ${sample.heavyMetalPb} ${pb.unit} ≥ ${pb.high} ${pb.unit}(严重)`);
  } else if (sample.heavyMetalPb >= pb.warn) {
    score += 30;
    flags.push(`${pb.label}超标`);
    details.push(`${pb.label} ${sample.heavyMetalPb} ${pb.unit} ≥ ${pb.warn} ${pb.unit}`);
  }

  // ---- 水分含量(超出合理区间记 20 分)----
  const m = sample.moisturePct;
  if (m < THRESHOLDS.moisturePct.low || m > THRESHOLDS.moisturePct.high) {
    score += 20;
    flags.push(`${THRESHOLDS.moisturePct.label}异常`);
    details.push(
      `${THRESHOLDS.moisturePct.label} ${m}${THRESHOLDS.moisturePct.unit} 超出合理区间 ` +
        `${THRESHOLDS.moisturePct.low}~${THRESHOLDS.moisturePct.high}${THRESHOLDS.moisturePct.unit}`
    );
  }

  return { riskScore: Math.min(score, 100), flags, details };
}

/**
 * AI 分析入口:默认使用内置规则引擎。
 * 接入真实 AI 模型时,在此替换为模型调用(如 POST AI_MODEL_URL 传入 sample),
 * 保持返回结构不变即可:{ riskScore:number(0-100), flags:string[], details:string[] }
 * @param {object} sample 结构化检测数据
 */
export async function analyze(sample) {
  return analyzeWithRules(sample);
}

/**
 * 构造 AI 预检完整报告(上传 IPFS 留档,链上只锚定其哈希):
 * 包含输入数据、判定阈值、分析结论与模型版本 —— 保证监管方可追溯
 * "AI 基于什么数据(输入+阈值)、用哪个模型(版本)、做出什么判断(评分+异常项)"。
 * @param {string} batchId 批次号
 * @param {object} sample  结构化检测数据(输入)
 * @param {{riskScore:number, flags:string[], details:string[]}} analysis 分析结论
 * @param {string} modelVersion 模型/规则引擎版本
 * @param {string} [analyzedAt] 分析时间(默认当前时间 ISO 格式)
 * @returns {string} 报告 JSON 字符串(格式化,便于人工审阅)
 */
export function buildReport(batchId, sample, analysis, modelVersion, analyzedAt = new Date().toISOString()) {
  return JSON.stringify(
    {
      type: 'AI_PRE_CHECK_REPORT',
      batchId,
      modelVersion,
      analyzedAt,
      input: sample,
      thresholds: THRESHOLDS,
      result: {
        riskScore: analysis.riskScore,
        riskLevel: riskLevelOf(analysis.riskScore),
        flags: analysis.flags,
        details: analysis.details,
      },
    },
    null,
    2
  );
}
