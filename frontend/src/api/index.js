// =============================================================================
// 后端 API 封装:统一带上当前角色(通过查询参数 ?role=xx 传递,见 backend/README.md
// 第 3 节),并统一处理响应格式 { ok, data } / { ok:false, error }。
//
// 约定:
//   - 所有函数返回后端 data 字段(即业务数据);
//   - 后端返回 ok:false 或 HTTP 非 2xx 时,抛出带可读文案的 Error,
//     页面统一用 try/catch + ElMessage.error 展示。
// =============================================================================

import axios from 'axios';
import { roleStore } from '../store/role.js';

// axios 实例:baseURL 为 /api(开发环境由 Vite 代理到后端,生产环境同域部署)
const http = axios.create({
  baseURL: '/api',
  timeout: 60000, // 链上交易包含背书/提交,耗时较长,放宽超时
});

/**
 * 统一请求:自动附加当前角色参数,并拆包 { ok, data } 响应。
 * @param {string} method  HTTP 方法
 * @param {string} url     接口路径(如 /batches)
 * @param {object} [data]  请求体(JSON)
 * @param {object} [config] 额外 axios 配置(如 multipart)
 * @returns {Promise<any>} 后端返回的 data 字段
 */
async function request(method, url, data, config = {}) {
  try {
    const res = await http.request({
      method,
      url,
      data,
      // 角色统一走查询参数,multipart 请求也能正常携带
      params: { ...(config.params ?? {}), role: roleStore.role },
      ...config,
    });
    if (res.data?.ok) {
      return res.data.data;
    }
    throw new Error(res.data?.error ?? '后端返回异常');
  } catch (err) {
    // 后端错误信息(含链码错误)统一透传为可读文案
    if (err.response?.data?.error) {
      throw new Error(err.response.data.error);
    }
    if (err.code === 'ERR_NETWORK') {
      throw new Error('无法连接后端服务,请确认 backend 已启动(npm start)');
    }
    throw err;
  }
}

// ---- 业务接口(与 backend/src/routes 一一对应) ----

/** 上传文件到 IPFS,返回 { cid, sha256, size, name } */
export async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  return request('post', '/upload', form); // FormData 自动走 multipart
}

/** 锚定批次:把 CID+哈希写入链上(operator) */
export async function anchorBatch(batchId, dataCid, sha256) {
  return request('post', '/batches', { batchId, dataCid, sha256 });
}

/** 核对签名:后端用核对人私钥签名并上链验签(checker) */
export async function counterSign(batchId) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/countersign`);
}

/** 核对驳回:核对人附原因驳回(checker),状态 ANCHORED → REJECTED */
export async function rejectCounterSign(batchId, reason) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/countersign-reject`, {
    reason,
  });
}

/** 整改重提:录入人上传整改版重新提交(operator),状态 REJECTED → ANCHORED */
export async function resubmitBatch(batchId, newCid, newSha256, reason) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/resubmit`, {
    newCid,
    newSha256,
    reason,
  });
}

/** AI 预检:提交结构化检测数据,链下分析 + 结论哈希上链存证(operator) */
export async function aiCheck(batchId, sample) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/ai-check`, sample);
}

/** AI 预检查询:返回 { aiCheck, verified },verified=报告哈希是否可追溯核验 */
export async function getAiCheck(batchId) {
  return request('get', `/batches/${encodeURIComponent(batchId)}/ai-check`);
}

/** 发起追加式修改请求(operator/checker) */
export async function requestModification(batchId, newCid, newSha256, reason) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/modification-request`, {
    newCid,
    newSha256,
    reason,
  });
}

/** 修改复核:批准或拒绝(auditor) */
export async function approveModification(batchId, approved) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/modification-approve`, {
    approved,
  });
}

/** 锁定发证(auditor) */
export async function finalizeBatch(batchId) {
  return request('post', `/batches/${encodeURIComponent(batchId)}/finalize`);
}

/** 批次详情(全角色) */
export async function getBatch(batchId) {
  return request('get', `/batches/${encodeURIComponent(batchId)}`);
}

/** 全版本历史(全角色,监管审计) */
export async function getVersions(batchId) {
  return request('get', `/batches/${encodeURIComponent(batchId)}/versions`);
}

/** 数字凭证 ID(仅 FINALIZED) */
export async function getCredential(batchId) {
  const { credentialId } = await request(
    'get',
    `/batches/${encodeURIComponent(batchId)}/credential`
  );
  return credentialId;
}

/** 消费者验证:外部哈希与链上比对,返回 'MATCH' | 'MISMATCH' */
export async function verifyBatch(batchId, sha256) {
  const { result } = await request('post', `/verify/${encodeURIComponent(batchId)}`, {
    sha256,
  });
  return result;
}

/** 构造 IPFS 文件访问地址(预览/下载;后端按 CID 从 IPFS 取回)。
 * 可选 filename:附带时后端设置 Content-Disposition,.json 报告可直接在
 * 浏览器新标签页以文本展示(否则按 octet-stream 下载)。 */
export function ipfsUrl(cid, filename) {
  const params = new URLSearchParams({ role: roleStore.role });
  if (filename) params.set('filename', filename);
  return `/api/ipfs/${encodeURIComponent(cid)}?${params.toString()}`;
}
