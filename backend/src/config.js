// =============================================================================
// 后端全局配置:统一从环境变量读取(backend/.env),未配置时使用默认值。
// 默认值与 network/ 的 test-network 改造版、链码 agrichain 严格对齐,
// 因此"复制仓库 → 跑起网络 → npm start"即可直接联调,无需额外配置。
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// 加载 backend/.env(文件不存在时静默跳过,全部走默认值)
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// backend/ 目录的绝对路径(用于把 .env 中的相对路径解析成绝对路径)
const BACKEND_ROOT = path.resolve(__dirname, '..');

/**
 * 读取环境变量;为空时回退默认值。
 * @param {string} name  变量名
 * @param {string} def   默认值
 */
function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export default {
  // ---- HTTP 服务 ----
  port: Number(env('PORT', '3000')),

  // ---- 链上目标 ----
  channelName: env('CHANNEL_NAME', 'agri-channel'),
  chaincodeName: env('CHAINCODE_NAME', 'agrichain'),

  // ---- 钱包(身份)目录 ----
  walletDir: path.resolve(BACKEND_ROOT, env('WALLET_DIR', './wallet')),

  // ---- IPFS Kubo RPC ----
  ipfsApiUrl: env('IPFS_API_URL', 'http://127.0.0.1:5001'),

  // ---- AI 异常检测(链下智能,见 services/ai.js)----
  // 引擎可插拔:AI_PROVIDER=rule(默认规则引擎)| http(外部模型服务);
  // http 模式下模型服务不可用时自动降级回退规则引擎(报告留痕)。
  aiProvider: env('AI_PROVIDER', 'rule'),
  aiModelUrl: env('AI_MODEL_URL', 'http://127.0.0.1:3100/analyze'),
  aiModelTimeoutMs: Number(env('AI_MODEL_TIMEOUT_MS', '3000')),
  // 规则引擎版本号,随 AI 预检报告一起锚定上链,便于追溯模型迭代
  aiModelVersion: env('AI_MODEL_VERSION', 'rule-engine-v1'),

  // ---- 各组织 peer 的网关连接参数 ----
  // peerHostname 是 peer 证书 SAN 中的主机名:客户端连 localhost 端口时,
  // 需要用它覆盖 TLS 主机名校验(grpc.ssl_target_name_override)。
  orgs: {
    org1: {
      peerEndpoint: env('ORG1_PEER_ENDPOINT', 'localhost:7051'),
      peerHostname: env('ORG1_PEER_HOSTNAME', 'peer0.org1.example.com'),
      tlsCertPath: path.resolve(
        BACKEND_ROOT,
        env(
          'ORG1_TLS_CERT_PATH',
          '../network/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem'
        )
      ),
    },
    org2: {
      peerEndpoint: env('ORG2_PEER_ENDPOINT', 'localhost:9051'),
      peerHostname: env('ORG2_PEER_HOSTNAME', 'peer0.org2.example.com'),
      tlsCertPath: path.resolve(
        BACKEND_ROOT,
        env(
          'ORG2_TLS_CERT_PATH',
          '../network/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem'
        )
      ),
    },
  },

  // ---- 角色 → 组织/钱包标签映射 ----
  // 钱包标签对应 wallet/<label>.id 文件,由 scripts/setup-wallet.js 生成;
  // 组织决定走哪个 peer 的网关连接(regulator 走 Org2,其余走 Org1)。
  roles: {
    operator: { org: 'org1', walletLabel: 'operator' },
    checker: { org: 'org1', walletLabel: 'checker' },
    auditor: { org: 'org1', walletLabel: 'auditor' },
    regulator: { org: 'org2', walletLabel: 'regulator' },
  },
};
