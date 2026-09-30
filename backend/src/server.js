// =============================================================================
// 后端服务入口:启动 HTTP 服务。
// 启动前请确认:
//   1. network 已启动且 agrichain 链码已部署(见 network/README.md);
//   2. 已执行 npm run setup-wallet 导入 4 个角色身份到 wallet/;
//   3. IPFS Kubo 节点已启动(IPFS_API_URL 可达)。
// 启动后可用 curl http://127.0.0.1:3000/api/health 检查链路。
// =============================================================================

import { createApp } from './app.js';
import config from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log('==============================================');
  console.log('  链田守护后端已启动');
  console.log(`  监听端口   : http://127.0.0.1:${config.port}`);
  console.log(`  通道/链码  : ${config.channelName} / ${config.chaincodeName}`);
  console.log(`  钱包目录   : ${config.walletDir}`);
  console.log(`  IPFS RPC   : ${config.ipfsApiUrl}`);
  console.log('  健康检查   : GET /api/health');
  console.log('==============================================');
});
