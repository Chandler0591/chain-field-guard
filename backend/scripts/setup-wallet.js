// =============================================================================
// 钱包导入脚本:把 network/ 里 Fabric CA 生成的 4 个业务角色身份,
// 转换为 fabric-gateway 钱包格式(backend/wallet/<角色>.id)。
//
// 前置条件(必须已执行,否则报错并提示):
//   cd network && ./network.sh up createChannel -ca
//     —— registerEnroll.sh 会在 organizations/ 下生成各角色 MSP:
//        Operator/Checker/Auditor@org1.example.com、Regulator@org2.example.com
//
// 运行方式:
//   cd backend && npm run setup-wallet
//
// 说明:钱包里存的是身份证书 + 私钥(私钥仅用于给交易提案签名),
// 已加入 .gitignore,绝不入库。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 仓库根目录(backend/ 的上一级),network/ 位于其下
const REPO_ROOT = path.resolve(__dirname, '../..');
const WALLET_DIR = path.resolve(__dirname, '../wallet');

// 4 个业务角色身份定义:
//   label   → 钱包文件名 wallet/<label>.id
//   mspId   → 身份所属组织(链码据此区分业务方/监管方)
//   mspDir  → network 下 CA 生成的该身份 MSP 目录
const IDENTITIES = [
  {
    label: 'operator',
    mspId: 'Org1MSP',
    mspDir: path.join(
      REPO_ROOT,
      'network/organizations/peerOrganizations/org1.example.com/users/Operator@org1.example.com/msp'
    ),
  },
  {
    label: 'checker',
    mspId: 'Org1MSP',
    mspDir: path.join(
      REPO_ROOT,
      'network/organizations/peerOrganizations/org1.example.com/users/Checker@org1.example.com/msp'
    ),
  },
  {
    label: 'auditor',
    mspId: 'Org1MSP',
    mspDir: path.join(
      REPO_ROOT,
      'network/organizations/peerOrganizations/org1.example.com/users/Auditor@org1.example.com/msp'
    ),
  },
  {
    label: 'regulator',
    mspId: 'Org2MSP',
    mspDir: path.join(
      REPO_ROOT,
      'network/organizations/peerOrganizations/org2.example.com/users/Regulator@org2.example.com/msp'
    ),
  },
];

/**
 * 从 MSP 目录读取身份材料:
 *   signcerts/cert.pem → 身份证书(公钥在证书里)
 *   keystore/<哈希>_sk → 身份私钥
 * @returns {{certificate: string, privateKey: string}} PEM 字符串
 */
function readMsp(mspDir) {
  if (!fs.existsSync(mspDir)) {
    throw new Error(
      `未找到身份目录:\n  ${mspDir}\n` +
        '请先执行(见 network/README.md):\n' +
        '  cd network && ./network.sh up createChannel -ca'
    );
  }
  // 签名证书(目录内通常只有 cert.pem 一个 PEM 文件)
  const signcertsDir = path.join(mspDir, 'signcerts');
  const certFiles = fs.readdirSync(signcertsDir).filter((f) => f.endsWith('.pem'));
  if (certFiles.length === 0) {
    throw new Error(`signcerts 目录下没有证书文件: ${signcertsDir}`);
  }
  // 私钥(文件名是随机哈希后缀的 _sk 文件)
  const keystoreDir = path.join(mspDir, 'keystore');
  const keyFiles = fs.readdirSync(keystoreDir).filter((f) => f.endsWith('_sk'));
  if (keyFiles.length === 0) {
    throw new Error(`keystore 目录下没有私钥文件: ${keystoreDir}`);
  }
  return {
    certificate: fs.readFileSync(path.join(signcertsDir, certFiles[0]), 'utf8'),
    privateKey: fs.readFileSync(path.join(keystoreDir, keyFiles[0]), 'utf8'),
  };
}

// ---- 主流程:逐个身份导入钱包 ----
fs.mkdirSync(WALLET_DIR, { recursive: true });

let okCount = 0;
for (const id of IDENTITIES) {
  try {
    const { certificate, privateKey } = readMsp(id.mspDir);
    // fabric-gateway 文件钱包格式:wallet/<label>.id,内容为 X.509 身份 JSON
    const walletIdentity = {
      type: 'X.509',
      mspId: id.mspId,
      credentials: { certificate, privateKey },
    };
    const target = path.join(WALLET_DIR, `${id.label}.id`);
    fs.writeFileSync(target, JSON.stringify(walletIdentity, null, 2), 'utf8');
    console.log(`[OK] ${id.label.padEnd(9)} (${id.mspId}) → wallet/${id.label}.id`);
    okCount++;
  } catch (err) {
    console.error(`[FAIL] ${id.label}: ${err.message}`);
  }
}

if (okCount === IDENTITIES.length) {
  console.log(`\n钱包初始化完成:${okCount}/${IDENTITIES.length} 个身份已导入 ${WALLET_DIR}`);
  console.log('下一步:npm start 启动后端,并用 GET /api/health 检查链路。');
} else {
  console.error(`\n钱包初始化未完成:仅成功 ${okCount}/${IDENTITIES.length} 个身份,请先搭建网络后重试。`);
  process.exitCode = 1;
}
