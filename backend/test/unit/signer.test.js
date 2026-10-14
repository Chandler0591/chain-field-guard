// =============================================================================
// 签名模块单元测试 —— 无需网络/链码,任何时候都能跑:
//   cd backend && npm test
//
// 验证点:
//   1. 签名数据包格式与链码约定一致(kind|batchId|cid|timestamp);
//   2. ECDSA P-256 签名/验签闭环;
//   3. 篡改任意字段(用途/批次号/CID/时间戳)后验签必失败;
//   4. 签名本身是合法的 ASN.1 DER 结构(链码 ecdsa.VerifyASN1 可解析)。
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildPayload,
  currentTimestampSeconds,
  signPayload,
  verifyPayload,
  publicKeyFromPrivate,
} from '../../src/services/signer.js';

// 每组测试独立生成一对 ECDSA P-256 密钥(模拟核对人身份私钥)
function generateKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

/** 密钥对象 → PEM 字符串(私钥 pkcs8、公钥 spki,两者格式不同) */
function toPem(keyObject) {
  const type = keyObject.type === 'private' ? 'pkcs8' : 'spki';
  return keyObject.export({ type, format: 'pem' }).toString();
}

test('buildPayload: 数据包格式为 kind|batchId|cid|clientTimestamp(与链码 SignPayloadFormat 一致)', () => {
  assert.equal(buildPayload('SIGN', 'B2026-001', 'QmAbCdEf', 1759266000), 'SIGN|B2026-001|QmAbCdEf|1759266000');
  // 时间戳是数字,拼接时自动转字符串,不能带小数
  assert.equal(buildPayload('REJECT', 'B2026-001', 'QmAbCdEf', 1759266000.0), 'REJECT|B2026-001|QmAbCdEf|1759266000');
});

test('currentTimestampSeconds: 返回当前 Unix 秒(与 Date.now 一致,误差 1 秒内)', () => {
  const now = Math.floor(Date.now() / 1000);
  const ts = currentTimestampSeconds();
  assert.ok(Math.abs(ts - now) <= 1, `期望 ${ts} 与 ${now} 误差不超过 1 秒`);
});

test('signPayload: 产出 hex 编码的 ASN.1 DER 签名', () => {
  const { privateKey } = generateKeyPair();
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);

  // hex 编码合法性
  assert.match(sigHex, /^[0-9a-f]+$/);
  const der = Buffer.from(sigHex, 'hex');

  // ASN.1 DER 首字节必须是 0x30(SEQUENCE),链码用 ecdsa.VerifyASN1 解析
  assert.equal(der[0], 0x30, 'DER 签名必须以 SEQUENCE(0x30)开头');
  // P-256 的 ECDSA 签名典型长度 70~72 字节
  assert.ok(der.length >= 64 && der.length <= 80, `DER 长度 ${der.length} 应在 64~80 字节之间`);
});

test('verifyPayload: 合法签名验签通过(闭环)', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const batchId = 'B2026-002';
  const cid = 'QmValidCid';
  const ts = 1759266000;

  const sigHex = signPayload(toPem(privateKey), 'SIGN', batchId, cid, ts);
  assert.equal(verifyPayload(toPem(publicKey), 'SIGN', batchId, cid, ts, sigHex), true);
});

test('verifyPayload: 签名用途(kind)不一致时验签失败(防跨用途重放)', () => {
  const { privateKey, publicKey } = generateKeyPair();
  // 签名时用途为 SIGN,验签时按 REJECT 重建数据包 → 必失败
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);
  assert.equal(verifyPayload(toPem(publicKey), 'REJECT', 'B001', 'QmX', 1759266000, sigHex), false);
});

test('verifyPayload: 篡改批次号后验签失败', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);
  assert.equal(verifyPayload(toPem(publicKey), 'SIGN', 'B002', 'QmX', 1759266000, sigHex), false);
});

test('verifyPayload: 篡改 CID 后验签失败(数据包绑定文件指纹)', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmRealFile', 1759266000);
  assert.equal(verifyPayload(toPem(publicKey), 'SIGN', 'B001', 'QmFakeFile', 1759266000, sigHex), false);
});

test('verifyPayload: 篡改时间戳后验签失败(防重放:旧签名不能换个时间复用)', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);
  assert.equal(verifyPayload(toPem(publicKey), 'SIGN', 'B001', 'QmX', 1759266001, sigHex), false);
});

test('verifyPayload: 签名本身被篡改后验签失败', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);
  // 翻转签名中间一个字节
  const flipped = sigHex.slice(0, 16) + (sigHex[16] === '0' ? '1' : '0') + sigHex.slice(17);
  assert.equal(verifyPayload(toPem(publicKey), 'SIGN', 'B001', 'QmX', 1759266000, flipped), false);
});

test('verifyPayload: 用错误的公钥验签失败(签名必须出自核对人本人)', () => {
  const { privateKey } = generateKeyPair();
  const other = generateKeyPair();
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);
  assert.equal(verifyPayload(toPem(other.publicKey), 'SIGN', 'B001', 'QmX', 1759266000, sigHex), false);
});

test('verifyPayload: 非法 hex 签名不抛异常,判为验签失败', () => {
  const { publicKey } = generateKeyPair();
  // Buffer.from 对非法 hex 会截断/返回空字节,verify 应得到 false 而不是崩溃
  assert.equal(verifyPayload(toPem(publicKey), 'SIGN', 'B001', 'QmX', 1759266000, 'zzz-not-hex'), false);
});

test('publicKeyFromPrivate: 能从私钥推导公钥(调试/自检辅助)', () => {
  const { privateKey, publicKey } = generateKeyPair();
  const derived = publicKeyFromPrivate(toPem(privateKey));
  assert.match(derived, /BEGIN PUBLIC KEY/);
  // 用推导出的公钥同样可以验签
  const sigHex = signPayload(toPem(privateKey), 'SIGN', 'B001', 'QmX', 1759266000);
  assert.equal(verifyPayload(derived, 'SIGN', 'B001', 'QmX', 1759266000, sigHex), true);
});
