// =============================================================================
// 批次业务路由:与链码 agrichain 的 10 个函数一一对应。
//
// 状态机流转(链码侧强制校验,后端只是转发):
//   AnchorData(operator)      INIT → ANCHORED
//   RecordAICheck(operator)   ANCHORED →(状态不变,AI 预检存证)
//   CounterSign(checker)      ANCHORED → COUNTER_SIGNED(后端签名,链上验签)
//   RequestModification(op/ch)COUNTER_SIGNED → PENDING
//   ApproveModification(au)   PENDING → COUNTER_SIGNED(批准=追加新版本)
//   FinalizeBatch(auditor)    COUNTER_SIGNED → FINALIZED(颁发凭证,锁定)
// =============================================================================

import crypto from 'node:crypto';
import { Router } from 'express';
import * as gateway from '../services/gateway.js';
import * as signer from '../services/signer.js';
import * as ipfs from '../services/ipfs.js';
import * as ai from '../services/ai.js';
import config from '../config.js';
import { requireRole } from '../middleware/role.js';

const router = Router();

// ---- 工具函数 -----------------------------------------------------------------

/**
 * 包装异步路由处理:Express 4 不会自动捕获 async 抛出的异常,
 * 统一在此转成 JSON 错误响应,并把链码错误信息提取成可读文案。
 */
function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      const message = gateway.extractError(err);
      // 链码报告批次不存在时映射为 404,其余按 500 返回
      const status = message.includes('不存在') ? 404 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  };
}

/** 成功响应统一格式 */
function ok(res, data) {
  res.json({ ok: true, data });
}

/** 取出批次当前生效版本(versions 数组按下标 currentVersion-1 索引) */
function currentVersionOf(batch) {
  return batch.versions[batch.currentVersion - 1];
}

// ---- 写接口 -------------------------------------------------------------------

/**
 * POST /api/batches —— 数据锚定(录入人)
 * 请求体:{ batchId, dataCid, sha256 }
 * 说明:dataCid/sha256 由 POST /api/upload 上传 IPFS 后获得。
 */
router.post(
  '/batches',
  requireRole('operator'),
  wrap(async (req, res) => {
    const { batchId, dataCid, sha256 } = req.body ?? {};
    if (!batchId || !dataCid || !sha256) {
      return res.status(400).json({ ok: false, error: 'batchId、dataCid、sha256 均为必填' });
    }
    const batch = await gateway.submitTx(req.role, 'AnchorData', batchId, dataCid, sha256);
    return ok(res, batch);
  })
);

/**
 * POST /api/batches/:id/ai-check —— AI 预检(录入人)
 * 请求体:{ origin?, produceType?, pesticideResidue, heavyMetalPb, moisturePct,
 *           totalBacteria?, nitrite? }
 *   - pesticideResidue 农药残留(mg/kg,数值必填)
 *   - heavyMetalPb     重金属铅(mg/kg,数值必填)
 *   - moisturePct      水分含量(%,数值必填)
 *   - totalBacteria    菌落总数(CFU/g,数值可选,提供时参与风险评分)
 *   - nitrite          亚硝酸盐(mg/kg,数值可选,提供时参与风险评分)
 *   - origin/produceType 产地与产品类型(字符串,可选,写入报告留痕)
 * 后端流程(链下智能 + 链上存证):
 *   1. 链下 AI 服务分析结构化检测数据(可插拔引擎:AI_PROVIDER=rule 内置
 *      规则引擎 | http 外部模型服务;模型服务不可用时自动降级回退规则引擎);
 *   2. 完整分析报告(输入/阈值/结论/引擎/模型版本)上传 IPFS 留档;
 *   3. 报告 CID + SHA-256 + 摘要结论(风险分/异常项/模型版本)随交易上链,
 *      链码 RecordAICheck 存证 —— AI 结论不改变批次状态机(仍为 ANCHORED)。
 */
router.post(
  '/batches/:id/ai-check',
  requireRole('operator'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const sample = req.body ?? {};

    // 1. 校验结构化检测数据(前三个数值字段必填且非负;菌落总数/亚硝酸盐为
    //    可选维度,提供时同样必须为非负数值;越界/非数字一律拒绝)
    for (const field of ['pesticideResidue', 'heavyMetalPb', 'moisturePct']) {
      const v = sample[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        return res.status(400).json({ ok: false, error: `${field} 必须为非负数值(如 0.02)` });
      }
    }
    for (const field of ['totalBacteria', 'nitrite']) {
      const v = sample[field];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        return res.status(400).json({ ok: false, error: `${field} 必须为非负数值(如 1000000)` });
      }
    }

    // 2. 前置状态检查:仅 ANCHORED(锚定之后、核对签名之前)且未预检过
    const batch = await gateway.evaluateTx(req.role, 'GetBatch', id);
    if (batch.status !== 'ANCHORED') {
      return res.status(409).json({
        ok: false,
        error: `批次 ${id} 当前状态为 ${batch.status},仅 ANCHORED 状态可执行 AI 预检`,
      });
    }
    if (batch.aiCheck) {
      return res.status(409).json({ ok: false, error: `批次 ${id} 已完成 AI 预检,不允许重复执行` });
    }

    // 3. 链下 AI 分析(可插拔引擎:AI_PROVIDER=rule 内置规则引擎 | http 外部模型
    //    服务;http 模式服务不可用时自动降级回退规则引擎,结果带 degradedFrom)
    const provider = ai.createProvider(config);
    const analysis = await ai.analyze(sample, provider);

    // 4. 确定上链的模型版本:http 模式成功用模型侧版本;降级时标注降级来源,
    //    保证监管方可追溯"这次判断用的是哪个引擎/模型"
    const modelVersion = analysis.degradedFrom
      ? `${config.aiModelVersion}(降级:模型服务不可用)`
      : (analysis.modelVersion ?? config.aiModelVersion);

    // 5. 完整报告上传 IPFS 并计算哈希(链上只锚定 CID + 哈希 + 摘要)
    const report = ai.buildReport(id, sample, analysis, modelVersion);
    const { cid: reportCid } = await ipfs.upload(
      Buffer.from(report, 'utf8'),
      `ai-report-${id}.json`
    );
    const reportHash = crypto.createHash('sha256').update(report).digest('hex');

    // 6. 结论哈希上链(RecordAICheck 存证,状态机不变)
    const updated = await gateway.submitTx(
      req.role,
      'RecordAICheck',
      id,
      reportCid,
      reportHash,
      String(analysis.riskScore),
      JSON.stringify(analysis.flags),
      modelVersion
    );
    // 明细不入链(链上只存摘要),附在响应里供前端逐项展示
    return ok(res, { ...updated, aiDetail: analysis.details });
  })
);

/**
 * GET /api/batches/:id/ai-check —— AI 预检查询(全角色,含监管方)
 * 返回:{ aiCheck, verified, detail }
 *   aiCheck:链上存证的 AI 预检结论(未预检时为 null);
 *   verified:追溯核验 —— 后端从 IPFS 取回报告原文并重算 SHA-256,
 *             与链上锚定的 reportHash 比对,true=报告未被篡改,false=不一致;
 *   detail:从 IPFS 报告解析的各维度得分明细(指标/检测值/得分/档位,不入链)。
 */
router.get(
  '/batches/:id/ai-check',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  wrap(async (req, res) => {
    const batch = await gateway.evaluateTx(req.role, 'GetBatch', req.params.id);
    const aiCheck = batch.aiCheck ?? null;
    let verified = null;
    let detail = [];
    if (aiCheck) {
      const report = await ipfs.download(aiCheck.reportCid);
      const hash = crypto.createHash('sha256').update(report).digest('hex');
      verified = hash === aiCheck.reportHash;
      // 从报告原文解析明细(报告结构见 services/ai.js buildReport)
      try {
        detail = JSON.parse(report.toString('utf8')).result?.details ?? [];
      } catch {
        detail = []; // 报告解析失败不阻塞查询,verified 已提示异常
      }
    }
    return ok(res, { aiCheck, verified, detail });
  })
);

/**
 * POST /api/batches/:id/countersign —— 核对签名(核对人)
 * 后端流程:
 *   1. 先查询批次,取当前生效版本的 CID;
 *   2. 用核对人钱包私钥(与提交交易的身份证书配对)对数据包
 *      "batchId|cid|当前Unix秒" 做 SHA-256 + ECDSA P-256 签名(DER,hex);
 *   3. 把签名与时间戳随交易上链,链码用核对人证书公钥验签并校验时间容差。
 * 无需请求体。
 */
router.post(
  '/batches/:id/countersign',
  requireRole('checker'),
  wrap(async (req, res) => {
    const { id } = req.params;

    // 1. 读取批次当前状态(核对人可查询)
    const batch = await gateway.evaluateTx(req.role, 'GetBatch', id);
    if (batch.status !== 'ANCHORED') {
      return res.status(409).json({
        ok: false,
        error: `批次 ${id} 当前状态为 ${batch.status},仅 ANCHORED 状态可核对签名`,
      });
    }

    // 2. 对当前生效版本签名(签名对象 = batchId|cid|clientTimestamp)
    const cid = currentVersionOf(batch).cid;
    const clientTimestamp = signer.currentTimestampSeconds();
    const privateKey = gateway.getRolePrivateKey(req.role);
    const signature = signer.signPayload(privateKey, id, cid, clientTimestamp);

    // 3. 签名 + 时间戳随交易上链,链码验签通过后状态推进为 COUNTER_SIGNED
    const updated = await gateway.submitTx(
      req.role, 'CounterSign', id, signature, String(clientTimestamp)
    );
    return ok(res, updated);
  })
);

/**
 * POST /api/batches/:id/modification-request —— 发起追加式修改(录入人/核对人)
 * 请求体:{ newCid, newSha256, reason }
 * 说明:只登记请求,不覆盖历史版本;批准后新版本追加、旧版本标记 DEPRECATED。
 */
router.post(
  '/batches/:id/modification-request',
  requireRole('operator', 'checker'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const { newCid, newSha256, reason } = req.body ?? {};
    if (!newCid || !newSha256) {
      return res.status(400).json({ ok: false, error: 'newCid、newSha256 为必填' });
    }
    const batch = await gateway.submitTx(
      req.role, 'RequestModification', id, newCid, newSha256, reason ?? ''
    );
    return ok(res, batch);
  })
);

/**
 * POST /api/batches/:id/modification-approve —— 修改复核(审核人)
 * 请求体:{ approved: true|false }(批准=追加新版本;拒绝=请求作废)
 */
router.post(
  '/batches/:id/modification-approve',
  requireRole('auditor'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const approved = req.body?.approved;
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'approved 必须为布尔值 true/false' });
    }
    const batch = await gateway.submitTx(
      req.role, 'ApproveModification', id, approved ? 'true' : 'false'
    );
    return ok(res, batch);
  })
);

/**
 * POST /api/batches/:id/finalize —— 锁定发证(审核人)
 * 状态推进为 FINALIZED,链码生成凭证 ID "VC-<batchId>-<txId>",此后拒绝一切写入。
 */
router.post(
  '/batches/:id/finalize',
  requireRole('auditor'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const batch = await gateway.submitTx(req.role, 'FinalizeBatch', id);
    return ok(res, batch);
  })
);

// ---- 读接口(四个角色全部可用,含监管方 regulator)-------------------------------

/**
 * GET /api/batches/:id —— 批次详情(状态、当前版本、签名、凭证 ID)
 */
router.get(
  '/batches/:id',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  wrap(async (req, res) => {
    const batch = await gateway.evaluateTx(req.role, 'GetBatch', req.params.id);
    return ok(res, batch);
  })
);

/**
 * GET /api/batches/:id/versions —— 全版本历史(含 DEPRECATED,审计追溯用)
 */
router.get(
  '/batches/:id/versions',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  wrap(async (req, res) => {
    const versions = await gateway.evaluateTx(req.role, 'GetAllVersions', req.params.id);
    return ok(res, versions);
  })
);

/**
 * GET /api/batches/:id/credential —— 数字凭证 ID(仅 FINALIZED 批次持有)
 */
router.get(
  '/batches/:id/credential',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  wrap(async (req, res) => {
    const credentialId = await gateway.evaluateRaw(req.role, 'GetCredential', req.params.id);
    return ok(res, { credentialId });
  })
);

/**
 * POST /api/verify/:id —— 消费者验证(任意角色,含监管方)
 * 请求体:{ sha256 } —— 链码把外部哈希与链上当前版本哈希比对,返回 MATCH/MISMATCH。
 */
router.post(
  '/verify/:id',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  wrap(async (req, res) => {
    const sha256 = req.body?.sha256;
    if (!sha256) {
      return res.status(400).json({ ok: false, error: 'sha256 为必填' });
    }
    const result = await gateway.evaluateRaw(req.role, 'VerifyBatch', req.params.id, sha256);
    return ok(res, { result });
  })
);

export default router;
