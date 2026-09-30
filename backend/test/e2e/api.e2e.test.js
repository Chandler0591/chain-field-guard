// =============================================================================
// 端到端集成测试 —— 跑通完整业务流:上传 → 锚定 → AI 预检 → 核对签名 → 修改 →
// 复核 → 锁定发证 → 消费者验证 → 监管审计,以及各越权场景的拒绝行为。
//
// 运行前置条件(缺一不可,详见 backend/README.md 第 5 节):
//   1. Fabric 网络已启动且链码已部署:
//        cd network && ./network.sh up createChannel -ca
//        ./network.sh deployCC -ccn agrichain -ccp ../chaincode/agrichain -ccl go
//   2. IPFS Kubo 节点已启动:
//        docker run -d --name ipfs -p 5001:5001 -p 8080:8080 ipfs/kubo
//   3. 后端依赖已安装且钱包已初始化:
//        cd backend && npm install && npm run setup-wallet
//
// 运行方式:
//   cd backend && E2E=1 npm run test:e2e
//
// 未设置 E2E=1 时本文件全部用例自动跳过(此时只打印运行说明),
// 不影响 npm test 的单元测试执行。
// =============================================================================

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';

// ---- E2E 开关:只有显式设置 E2E=1 才真正执行 ----
const RUN_E2E = process.env.E2E === '1';

if (!RUN_E2E) {
  console.log(`
================================================================================
[跳过] 端到端测试需要真实 Fabric 网络与 IPFS 节点,未检测到 E2E=1。

前置条件(依次执行):
  1) cd network && ./network.sh up createChannel -ca
  2) ./network.sh deployCC -ccn agrichain -ccp ../chaincode/agrichain -ccl go
  3) docker run -d --name ipfs -p 5001:5001 -p 8080:8080 ipfs/kubo
  4) cd ../backend && npm install && npm run setup-wallet

运行方式:
  cd backend && E2E=1 npm run test:e2e
================================================================================
`);
}

// ---- 测试服务:用临时端口启动后端(不影响真实 3000 端口) ----
let server;
let baseUrl;

before(async () => {
  if (!RUN_E2E) return;
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---- 请求辅助 ----

/** 统一请求封装:JSON 响应解析 + 断言 ok:true */
async function api(method, path, { role, body } = {}) {
  const url = new URL(`/api${path}`, baseUrl);
  if (role) url.searchParams.set('role', role);
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

/** 调用成功接口并返回 data 字段 */
async function apiOk(method, path, opts) {
  const { status, data } = await api(method, path, opts);
  assert.equal(data.ok, true, `期望 ${method} ${path} 成功,实际: ${JSON.stringify(data)}`);
  return { status, data: data.data };
}

// ---- 跨用例共享的上下文(测试按声明顺序串行执行) ----
const ctx = {
  batchId: `E2E-${Date.now()}`, // 唯一批次号,允许重复运行
  cidV1: null, // 首版文件 CID
  shaV1: null, // 首版文件 SHA-256
  cidV2: null, // 修改后文件 CID
  shaV2: null, // 修改后文件 SHA-256
  aiReportCid: null, // AI 预检报告 CID(用例 4 写入,用例 5 核验)
};

/** 生成一段测试文件内容(大小写敏感,便于区分版本) */
function makeContent(version) {
  return Buffer.from(
    `链田守护端到端测试文件 v${version} —— 生成于 ${new Date().toISOString()} 批次 ${ctx.batchId}`,
    'utf8'
  );
}

/** multipart 文件上传,返回 { cid, sha256 } */
async function uploadFile(content, filename) {
  const form = new FormData();
  form.append('file', new Blob([content]), filename);
  const url = new URL('/api/upload', baseUrl);
  url.searchParams.set('role', 'operator');
  const res = await fetch(url, { method: 'POST', body: form });
  const payload = await res.json();
  assert.equal(payload.ok, true, `上传失败: ${JSON.stringify(payload)}`);
  return payload.data;
}

// =============================================================================
// 用例 1:健康检查 —— 确认后端 → 链上链路可用
// =============================================================================
test('01 健康检查:后端可达且链码连通', { skip: !RUN_E2E }, async () => {
  const { data } = await apiOk('GET', '/health', { role: 'operator' });
  assert.equal(data.status, 'healthy');
});

// =============================================================================
// 用例 2:IPFS 上传 —— 得到 CID 与 SHA-256(链上只存这两个指纹)
// =============================================================================
test('02 IPFS 上传:返回 CID 与 SHA-256', { skip: !RUN_E2E }, async () => {
  const content = makeContent(1);
  const uploaded = await uploadFile(content, `report-${ctx.batchId}-v1.txt`);

  assert.match(uploaded.cid, /^Qm/, 'CID 应为 CIDv0(Qm 开头)');
  assert.equal(uploaded.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  ctx.cidV1 = uploaded.cid;
  ctx.shaV1 = uploaded.sha256;

  // 上传后应能按 CID 取回且内容一致(核对人预览、消费者验证的基础)
  const url = new URL(`/api/ipfs/${ctx.cidV1}`, baseUrl);
  url.searchParams.set('role', 'checker');
  const res = await fetch(url);
  const back = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200);
  assert.deepEqual(back, content, 'IPFS 取回的内容应与上传一致');
});

// =============================================================================
// 用例 3:锚定 —— operator 把 CID+哈希写入链上(INIT → ANCHORED)
// =============================================================================
test('03 锚定:operator 锚定批次,状态为 ANCHORED', { skip: !RUN_E2E }, async () => {
  const { data: batch } = await apiOk('POST', '/batches', {
    role: 'operator',
    body: { batchId: ctx.batchId, dataCid: ctx.cidV1, sha256: ctx.shaV1 },
  });

  assert.equal(batch.status, 'ANCHORED');
  assert.equal(batch.currentVersion, 1);
  assert.equal(batch.versions.length, 1);
  assert.equal(batch.versions[0].cid, ctx.cidV1);
  assert.equal(batch.versions[0].sha256, ctx.shaV1);
});

// =============================================================================
// 用例 4:AI 预检 —— operator 触发链下 AI 分析,结论哈希上链(状态机不变)
// =============================================================================
test('04 AI 预检:operator 触发链下分析,风险结论哈希上链', { skip: !RUN_E2E }, async () => {
  // 提交结构化检测数据:农药残留 0.03 mg/kg 命中警示阈值 → 预期 30 分 WARN
  const { data: batch } = await apiOk('POST', `/batches/${ctx.batchId}/ai-check`, {
    role: 'operator',
    body: {
      origin: '山东寿光',
      produceType: '叶菜类',
      pesticideResidue: 0.03,
      heavyMetalPb: 0.02,
      moisturePct: 9,
    },
  });

  // 关键约束:AI 结论是辅助证据,不得推进状态机(仍为 ANCHORED)
  assert.equal(batch.status, 'ANCHORED');
  const ai = batch.aiCheck;
  assert.ok(ai, '链上应记录 AI 预检结论');
  assert.equal(ai.riskLevel, 'WARN');
  assert.equal(ai.riskScore, 30);
  assert.match(ai.reportCid, /^Qm/, 'AI 报告 CID 应为 CIDv0');
  assert.match(ai.reportHash, /^[0-9a-f]{64}$/, '链上应锚定报告 SHA-256');
  assert.deepEqual(ai.flags, ['农药残留超标']);
  assert.equal(ai.modelVersion, 'rule-engine-v1');
  ctx.aiReportCid = ai.reportCid;
});

// =============================================================================
// 用例 5:AI 预检查询 —— 监管方可读且报告哈希可追溯核验
// =============================================================================
test('05 AI 预检查询:监管方可读且报告哈希可核验(追溯 AI 判断依据)', { skip: !RUN_E2E }, async () => {
  const { data } = await apiOk('GET', `/batches/${ctx.batchId}/ai-check`, { role: 'regulator' });

  assert.equal(data.aiCheck.riskLevel, 'WARN');
  assert.equal(data.aiCheck.reportCid, ctx.aiReportCid);
  assert.equal(data.verified, true, 'IPFS 报告重算哈希应与链上锚定哈希一致(报告未被篡改)');
});

// =============================================================================
// 用例 5b:AI 预检扩展维度 —— 菌落总数(可选维度)参与评分,链码无需感知新维度
// =============================================================================
test('05b AI 预检扩展维度:菌落总数 1e6 → WARN 30 分,可选维度参与评分', { skip: !RUN_E2E }, async () => {
  const batchId = `${ctx.batchId}-TB`; // 独立批次,不影响主流程用例
  const content = makeContent(3);
  const uploaded = await uploadFile(content, `report-${batchId}.txt`);
  await apiOk('POST', '/batches', {
    role: 'operator',
    body: { batchId, dataCid: uploaded.cid, sha256: uploaded.sha256 },
  });

  const { data: batch } = await apiOk('POST', `/batches/${batchId}/ai-check`, {
    role: 'operator',
    body: {
      origin: '山东寿光',
      produceType: '叶菜类',
      pesticideResidue: 0.001,
      heavyMetalPb: 0.01,
      moisturePct: 9,
      totalBacteria: 1e6, // 可选维度:命中警示阈值(链码只存摘要,无需感知新维度)
    },
  });

  assert.equal(batch.status, 'ANCHORED', 'AI 结论不改变状态机');
  assert.equal(batch.aiCheck.riskScore, 30);
  assert.equal(batch.aiCheck.riskLevel, 'WARN');
  assert.deepEqual(batch.aiCheck.flags, ['菌落总数超标']);
});

// =============================================================================
// 用例 5c:AI 预检 HIGH 场景 —— 严重阈值命中,响应附带得分明细(不入链)
// =============================================================================
test('05c AI 预检 HIGH 场景:农残 0.15 → HIGH 60 分,响应含得分明细', { skip: !RUN_E2E }, async () => {
  const batchId = `${ctx.batchId}-HIGH`; // 独立批次,不影响主流程用例
  const content = makeContent(4);
  const uploaded = await uploadFile(content, `report-${batchId}.txt`);
  await apiOk('POST', '/batches', {
    role: 'operator',
    body: { batchId, dataCid: uploaded.cid, sha256: uploaded.sha256 },
  });

  const { data: batch } = await apiOk('POST', `/batches/${batchId}/ai-check`, {
    role: 'operator',
    body: {
      origin: '山东寿光',
      produceType: '叶菜类',
      pesticideResidue: 0.15, // 命中严重阈值 → 60 分 HIGH
      heavyMetalPb: 0.02,
      moisturePct: 9,
    },
  });

  assert.equal(batch.status, 'ANCHORED', 'AI 结论不改变状态机');
  assert.equal(batch.aiCheck.riskScore, 60);
  assert.equal(batch.aiCheck.riskLevel, 'HIGH');
  assert.deepEqual(batch.aiCheck.flags, ['农药残留严重超标']);
  // 响应附带的得分明细(不入链,链上只存摘要)
  assert.ok(Array.isArray(batch.aiDetail), '响应应附带各维度得分明细');
  assert.equal(batch.aiDetail[0].metric, '农药残留');
  assert.equal(batch.aiDetail[0].score, 60);

  // 查询接口同样返回明细(从 IPFS 报告解析,监管追溯)
  const { data: q } = await apiOk('GET', `/batches/${batchId}/ai-check`, { role: 'regulator' });
  assert.equal(q.verified, true);
  assert.ok(Array.isArray(q.detail) && q.detail.length === 1, '查询接口应从报告解析出明细');
});

// =============================================================================
// 用例 6:核对签名 —— checker 后端签名、链上验签(ANCHORED → COUNTER_SIGNED)
// =============================================================================
test('06 核对签名:checker 签名后状态为 COUNTER_SIGNED,签名留痕', { skip: !RUN_E2E }, async () => {
  const { data: batch } = await apiOk('POST', `/batches/${ctx.batchId}/countersign`, {
    role: 'checker',
  });

  assert.equal(batch.status, 'COUNTER_SIGNED');
  assert.equal(batch.signatures.length, 1);
  assert.match(batch.signatures[0], /^[0-9a-f]+$/, '链上应记录核对人签名(hex)');
});

// =============================================================================
// 用例 7:发起修改 —— operator 提交新版本(PENDING,历史不覆盖)
// =============================================================================
test('07 发起修改:operator 提交修改请求,状态为 PENDING', { skip: !RUN_E2E }, async () => {
  const content = makeContent(2);
  const uploaded = await uploadFile(content, `report-${ctx.batchId}-v2.txt`);
  ctx.cidV2 = uploaded.cid;
  ctx.shaV2 = uploaded.sha256;

  const { data: batch } = await apiOk('POST', `/batches/${ctx.batchId}/modification-request`, {
    role: 'operator',
    body: { newCid: ctx.cidV2, newSha256: ctx.shaV2, reason: '检验报告内容更正' },
  });

  assert.equal(batch.status, 'PENDING');
  assert.equal(batch.pendingModification.newCid, ctx.cidV2);
  assert.equal(batch.pendingModification.reason, '检验报告内容更正');
});

// =============================================================================
// 用例 8:修改复核 —— auditor 批准,新版本追加、旧版本 DEPRECATED
// =============================================================================
test('08 修改复核:auditor 批准后追加 v2,旧版本标记 DEPRECATED', { skip: !RUN_E2E }, async () => {
  const { data: batch } = await apiOk('POST', `/batches/${ctx.batchId}/modification-approve`, {
    role: 'auditor',
    body: { approved: true },
  });

  assert.equal(batch.status, 'COUNTER_SIGNED');
  assert.equal(batch.currentVersion, 2);
  assert.equal(batch.versions.length, 2, '修改是追加式,历史版本必须保留');
  assert.equal(batch.versions[0].status, 'DEPRECATED', '旧版本应标记为 DEPRECATED');
  assert.equal(batch.versions[1].status, 'ACTIVE');
  assert.equal(batch.versions[1].cid, ctx.cidV2);
  assert.equal(batch.pendingModification, null, '复核后待审核请求应清空');
});

// =============================================================================
// 用例 9:锁定发证 —— auditor 锁定,生成凭证 ID(COUNTER_SIGNED → FINALIZED)
// =============================================================================
test('09 锁定发证:auditor 锁定后生成凭证 ID', { skip: !RUN_E2E }, async () => {
  const { data: batch } = await apiOk('POST', `/batches/${ctx.batchId}/finalize`, {
    role: 'auditor',
  });

  assert.equal(batch.status, 'FINALIZED');
  assert.match(batch.credentialId, new RegExp(`^VC-${ctx.batchId}-`), '凭证 ID 格式应为 VC-<batchId>-<txId>');
});

// =============================================================================
// 用例 10:消费者验证 —— 用链上哈希核验文件,MATCH / MISMATCH
// =============================================================================
test('10 消费者验证:正确哈希 MATCH,篡改哈希 MISMATCH', { skip: !RUN_E2E }, async () => {
  const okCase = await apiOk('POST', `/verify/${ctx.batchId}`, {
    role: 'regulator',
    body: { sha256: ctx.shaV2 }, // 当前生效版本是 v2
  });
  assert.equal(okCase.result, 'MATCH');

  const badCase = await apiOk('POST', `/verify/${ctx.batchId}`, {
    role: 'regulator',
    body: { sha256: '0'.repeat(64) },
  });
  assert.equal(badCase.result, 'MISMATCH');
});

// =============================================================================
// 用例 11:监管审计 —— regulator 全程只读查询(批次详情/全版本历史/凭证)
// =============================================================================
test('11 监管审计:regulator 可查询批次、全版本历史与凭证', { skip: !RUN_E2E }, async () => {
  const { data: batch } = await apiOk('GET', `/batches/${ctx.batchId}`, { role: 'regulator' });
  assert.equal(batch.status, 'FINALIZED');
  assert.equal(batch.versions.length, 2);

  const { data: versions } = await apiOk('GET', `/batches/${ctx.batchId}/versions`, {
    role: 'regulator',
  });
  assert.equal(versions.length, 2, '监管应能看到全部版本(含 DEPRECATED)');
  assert.equal(versions[0].status, 'DEPRECATED');
  assert.equal(versions[1].status, 'ACTIVE');

  const { data: credential } = await apiOk('GET', `/batches/${ctx.batchId}/credential`, {
    role: 'regulator',
  });
  assert.match(credential.credentialId, new RegExp(`^VC-${ctx.batchId}-`));
});

// =============================================================================
// 用例 12:越权与边界拒绝 —— 后端角色白名单 + 链码状态机双重防线
// =============================================================================
test('12a 越权:监管方调用写接口被后端拒绝(403)', { skip: !RUN_E2E }, async () => {
  const { status, data } = await api('POST', '/batches', {
    role: 'regulator',
    body: { batchId: 'HACK-1', dataCid: 'QmX', sha256: 'a'.repeat(64) },
  });
  assert.equal(status, 403);
  assert.equal(data.ok, false);
  assert.match(data.error, /无权/);
});

test('12b 越权:核对人调用锁定接口被后端拒绝(403)', { skip: !RUN_E2E }, async () => {
  const { status, data } = await api('POST', `/batches/${ctx.batchId}/finalize`, {
    role: 'checker',
  });
  assert.equal(status, 403);
  assert.equal(data.ok, false);
});

test('12c 状态机:锁定后任何写操作都被链码拒绝', { skip: !RUN_E2E }, async () => {
  // 批次已 FINALIZED,再发起修改 → 链码拒绝(状态机保护)
  const { status, data } = await api('POST', `/batches/${ctx.batchId}/modification-request`, {
    role: 'operator',
    body: { newCid: ctx.cidV1, newSha256: ctx.shaV1, reason: '锁定后不应再允许修改' },
  });
  assert.equal(status, 500);
  assert.equal(data.ok, false);
  assert.match(data.error, /仅|状态/, '链码应返回状态机错误信息');
});

test('12d 查询:不存在的批次返回 404', { skip: !RUN_E2E }, async () => {
  const { status, data } = await api('GET', '/batches/NO-SUCH-BATCH', { role: 'regulator' });
  assert.equal(status, 404);
  assert.match(data.error, /不存在/);
});
