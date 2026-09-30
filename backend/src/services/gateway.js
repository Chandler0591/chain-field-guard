// =============================================================================
// 网关服务:fabric-gateway 连接的统一封装。
//
// 设计要点:
//   1. 按"角色"选身份:前端传 role(operator/checker/auditor/regulator),
//      后端从 wallet/<role>.id 读取对应身份证书与私钥提交交易 ——
//      即"钱包按角色切换身份",链上权限由身份证书中的 role 属性决定。
//   2. 每次请求建立短连接:提交/查询完成后立即关闭 gRPC 连接,
//      避免长连接在演示场景下的状态问题,实现也最简单。
//   3. 开启服务发现(asLocalhost):test-network 的通道背书策略是 MAJORITY
//      (两个组织都要背书),网关会通过 discovery 自动向 Org1/Org2 的
//      peer 收集背书,单连一个 peer 也能满足策略。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import grpc from '@grpc/grpc-js';
// @hyperledger/fabric-gateway 是 CommonJS 包,ESM 下用默认导入最稳妥
import gatewayModule from '@hyperledger/fabric-gateway';
import config from '../config.js';

const { connect } = gatewayModule;
const { signers } = gatewayModule;

/**
 * 从钱包文件读取身份。
 * 钱包文件格式(与 setup-wallet.js 生成一致):
 *   wallet/<label>.id = { type:'X.509', mspId, credentials:{ certificate, privateKey } }
 * @param {string} label 钱包标签(即角色名)
 */
function readIdentity(label) {
  const file = path.join(config.walletDir, `${label}.id`);
  if (!fs.existsSync(file)) {
    throw new Error(`钱包中不存在身份 "${label}"(${file})。请先完成网络搭建后执行:npm run setup-wallet`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 建立到 peer 的 gRPC 连接(带 TLS)。
 * 客户端连 localhost 端口,但 peer 证书 SAN 是 peer0.orgX.example.com,
 * 因此用 grpc.ssl_target_name_override 把 TLS 主机名校验指向证书中的主机名。
 * @param {{peerEndpoint:string, peerHostname:string, tlsCertPath:string}} org 组织连接参数(见 config.js)
 */
function newGrpcConnection(org) {
  const tlsRootCert = fs.readFileSync(org.tlsCertPath);
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
  return new grpc.Client(org.peerEndpoint, tlsCredentials, {
    'grpc.ssl_target_name_override': org.peerHostname,
  });
}

/**
 * 以指定角色身份打开网关会话,返回 { client, gateway, contract }。
 * 调用方用完必须执行 gateway.close() 与 client.close() 释放资源。
 * @param {string} role operator | checker | auditor | regulator
 */
async function openSession(role) {
  const roleConf = config.roles[role];
  if (!roleConf) {
    throw new Error(`未知角色 "${role}",可选: ${Object.keys(config.roles).join('/')}`);
  }

  // 1. 从钱包读取该角色的身份证书与私钥
  const identity = readIdentity(roleConf.walletLabel);

  // 2. 建立到本组织 peer 的 gRPC 连接
  const client = newGrpcConnection(config.orgs[roleConf.org]);

  // 3. 用身份私钥构造签名器(交易提案签名),打开网关
  const gateway = connect({
    client,
    identity: {
      mspId: identity.mspId,
      credentials: identity.credentials,
    },
    signer: signers.newPrivateKeySigner(identity.credentials.privateKey),
    // 服务发现:自动发现通道内全部 peer 收集背书(asLocalhost 把发现的
    // docker 主机名重写为 localhost,与本机端口映射一致)
    discovery: { enabled: true, asLocalhost: true },
  });

  // 4. 定位 agri-channel 上的 agrichain 合约
  const network = gateway.getNetwork(config.channelName);
  const contract = network.getContract(config.chaincodeName);

  return { client, gateway, contract };
}

/**
 * 以指定角色身份执行一次链上操作(自动开关连接)。
 * @param {string} role 角色名
 * @param {(contract: import('@hyperledger/fabric-gateway').Contract) => Promise<T>} fn 操作回调
 * @returns {Promise<T>}
 */
async function withContract(role, fn) {
  const { client, gateway, contract } = await openSession(role);
  try {
    return await fn(contract);
  } finally {
    gateway.close();
    client.close();
  }
}

/** 把网关返回的字节结果解码为 UTF-8 字符串 */
function decode(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 提交写交易(锚定/签名/修改/锁定等),返回链码返回的 JSON 对象。
 * @param {string} role 角色名
 * @param {string} fn   链码函数名(如 AnchorData)
 * @param {...string} args 链码参数(全部按字符串传递,布尔传 'true'/'false')
 */
export async function submitTx(role, fn, ...args) {
  return withContract(role, async (contract) => {
    const bytes = await contract.submitTransaction(fn, ...args);
    return JSON.parse(decode(bytes));
  });
}

/**
 * 评估查询交易(读世界状态,不上链),返回链码返回的 JSON 对象。
 * @param {string} role 角色名
 * @param {string} fn   链码函数名(如 GetBatch)
 * @param {...string} args 链码参数
 */
export async function evaluateTx(role, fn, ...args) {
  return withContract(role, async (contract) => {
    const bytes = await contract.evaluateTransaction(fn, ...args);
    return JSON.parse(decode(bytes));
  });
}

/**
 * 评估查询交易,返回原始字符串(不做 JSON 解析)。
 * 用于链码返回裸字符串的函数,如 VerifyBatch("MATCH"/"MISMATCH")、
 * GetCredential("VC-<batchId>-<txId>")。
 * @param {string} role 角色名
 * @param {string} fn   链码函数名
 * @param {...string} args 链码参数
 * @returns {Promise<string>} 链码返回的原始字符串
 */
export async function evaluateRaw(role, fn, ...args) {
  return withContract(role, async (contract) => {
    const bytes = await contract.evaluateTransaction(fn, ...args);
    return decode(bytes);
  });
}

/**
 * 读取指定角色身份的私钥 PEM(核对人签名用)。
 * 私钥与提交交易的身份证书一一对应 —— 后端用核对人私钥签名,
 * 链码用调用者(核对人)证书公钥验签,天然闭环。
 * @param {string} role 角色名(实际只会用到 checker)
 * @returns {string} 私钥 PEM 字符串
 */
export function getRolePrivateKey(role) {
  const roleConf = config.roles[role];
  if (!roleConf) {
    throw new Error(`未知角色 "${role}",可选: ${Object.keys(config.roles).join('/')}`);
  }
  return readIdentity(roleConf.walletLabel).credentials.privateKey;
}

/**
 * 提取链码/网关错误的可读信息。
 * fabric-gateway 把链码错误放在 EndorseError.details[].message 里
 * (每个背书 peer 一条),这里取第一条拼接返回给前端。
 */
export function extractError(err) {
  const details = (err?.details ?? [])
    .map((d) => d?.message ?? '')
    .filter(Boolean);
  if (details.length > 0) {
    return details.join('; ');
  }
  return err?.message ?? String(err);
}
