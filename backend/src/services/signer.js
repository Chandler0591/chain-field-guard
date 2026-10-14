// =============================================================================
// 签名模块(核对人侧,与链码验签逻辑严格对齐)
//
// 签名约定(安全契约,前后端/链码三方一致,不可随意改动):
//   数据包 payload = kind + "|" + batchId + "|" + 当前版本 CID + "|" + clientTimestamp
//   - kind 区分签名用途:签名通过 SIGN / 核对驳回 REJECT(防跨用途重放);
//   - clientTimestamp 为核对人签名时本机 Unix 秒(整数);
//   - 对 payload 做 SHA-256 后,用核对人 ECDSA P-256 私钥签名(ASN.1 DER);
//   - 签名 hex 编码后随交易上链,链码 CounterSign/RejectCounterSign 用调用者
//     证书公钥验签,并校验 |clientTimestamp - 链上交易时间戳| ≤ 600 秒(防重放)。
//
// 链码对应实现见 chaincode/agrichain/access.go 的 verifySignature/signPayload
// 与 types.go 的 SignPayloadFormat、TimestampToleranceSeconds。
// =============================================================================

import crypto from 'node:crypto';

/** 签名用途常量(与链码 types.go 的 SignKindCounterSign/SignKindReject 一致) */
export const SIGN_KIND_COUNTER_SIGN = 'SIGN'; // 核对签名通过(CounterSign)
export const SIGN_KIND_REJECT = 'REJECT'; // 核对驳回(RejectCounterSign)

/**
 * 构造签名数据包字符串。
 * 格式与链码 types.go 中 SignPayloadFormat = "%s|%s|%s|%d" 完全一致。
 * @param {string} kind            签名用途(SIGN/REJECT,防跨用途重放)
 * @param {string} batchId         批次号
 * @param {string} cid             批次当前生效版本的 IPFS CID
 * @param {number} clientTimestamp 客户端签名时间戳(Unix 秒)
 * @returns {string} 如 "SIGN|B2026-001|QmAbCd...|1759266000"
 */
export function buildPayload(kind, batchId, cid, clientTimestamp) {
  return `${kind}|${batchId}|${cid}|${clientTimestamp}`;
}

/**
 * 当前 Unix 秒(签名时间戳)。
 * 链码校验它与链上交易时间戳偏差不超过 600 秒,因此签名与提交之间
 * 的间隔必须小于该容差(正常 HTTP 请求耗时远小于此值)。
 */
export function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 用 ECDSA P-256 私钥对数据包签名,返回 hex 字符串。
 *
 * 实现说明:crypto.sign('sha256', payload, key) 内部先对 payload 计算
 * SHA-256 再签摘要,与链码 verifySignature 中
 * "digest := sha256.Sum256(payload); ecdsa.VerifyASN1(pub, digest, sig)" 等价。
 *
 * @param {string|Buffer} privateKeyPem 核对人 ECDSA P-256 私钥(PEM)
 * @param {string} kind                 签名用途(SIGN/REJECT,防跨用途重放)
 * @param {string} batchId              批次号
 * @param {string} cid                  批次当前生效版本的 IPFS CID
 * @param {number} clientTimestamp      签名时间戳(Unix 秒)
 * @returns {string} 签名(hex 编码的 ASN.1 DER)
 */
export function signPayload(privateKeyPem, kind, batchId, cid, clientTimestamp) {
  const payload = Buffer.from(buildPayload(kind, batchId, cid, clientTimestamp), 'utf8');
  const signature = crypto.sign('sha256', payload, {
    key: privateKeyPem,
    dsaEncoding: 'der', // ASN.1 DER 编码,链码 ecdsa.VerifyASN1 直接可解析
  });
  return signature.toString('hex');
}

/**
 * 本地自检验签(与链码验证逻辑一致,供单元测试与调试使用)。
 * @returns {boolean} true=签名有效;false=数据被篡改或签名不匹配
 */
export function verifyPayload(publicKeyPem, kind, batchId, cid, clientTimestamp, signatureHex) {
  const payload = Buffer.from(buildPayload(kind, batchId, cid, clientTimestamp), 'utf8');
  return crypto.verify('sha256', payload, publicKeyPem, Buffer.from(signatureHex, 'hex'));
}

/**
 * 从私钥 PEM 推导公钥 PEM(SPKI 格式,调试/自检用)。
 */
export function publicKeyFromPrivate(privateKeyPem) {
  return crypto
    .createPublicKey(privateKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
}
