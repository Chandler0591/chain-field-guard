// =============================================================================
// IPFS 服务:封装 kubo-rpc-client,提供"上传文件"与"按 CID 读取"两个能力。
//
// 架构约定:文件本体存在 IPFS(链下),链上只保存 CID + SHA-256 指纹,
// 消费者拿 CID 从 IPFS 取回文件后,可用链上哈希核验未被篡改。
// =============================================================================

import { create } from 'kubo-rpc-client';
import config from '../config.js';

// 创建指向本地 Kubo 节点的客户端(地址来自 IPFS_API_URL,默认 http://127.0.0.1:5001)
const ipfs = create({ url: config.ipfsApiUrl });

/**
 * 上传文件内容到 IPFS。
 * @param {Buffer|Uint8Array} content 文件字节
 * @param {string} [name='file']      文件名(写入 IPFS 目录项,便于识别)
 * @returns {Promise<{cid: string, size: number}>} CID 字符串与文件大小
 */
export async function upload(content, name = 'file') {
  const { cid, size } = await ipfs.add({ path: name, content });
  return { cid: cid.toString(), size };
}

/**
 * 按 CID 从 IPFS 读取文件全部内容(核对预览、消费者验证页使用)。
 * @param {string} cid 文件 CID
 * @returns {Promise<Buffer>} 文件字节
 */
export async function download(cid) {
  const chunks = [];
  for await (const chunk of ipfs.cat(cid)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
