# 链田守护 · ChainField Guard

> 基于联盟链的农产品质量安全检验与数字凭证管理系统

## 项目定位

面向农产品质量安全场景，构建一个"数据可信锚定 → 多角色签名 → 修改可审计 → 数字凭证颁发"的全流程管理系统。链上只存哈希与签名，文件本体存于 IPFS，通过联盟链（Hyperledger Fabric）保证数据不可篡改、操作不可抵赖、历史全量可查。

## 技术栈

| 层 | 技术选型 |
| :--- | :--- |
| 联盟链 | Hyperledger Fabric 2.5（多组织、多角色权限） |
| 链下存储 | IPFS（存文件，链上存 CID + SHA-256） |
| 链码 | Go（状态机 + 多版本追加） |
| 后端 | Node.js + Express（Fabric Gateway 模式） |
| 前端 | Vue 3（角色切换面板 + 各环节操作页） |

## 核心业务流程

批次状态机：`INIT → ANCHORED → COUNTER_SIGNED ⇄ PENDING → FINALIZED`

1. **数据锚定（录入人）**：文件上传 IPFS 得 CID，计算 SHA-256，调用 `AnchorData` 写入链上
2. **二级签名（核对人）**：核对无误后对数据包签名，调用 `CounterSign` 永久上链
3. **修改复核（录入人/审核人）**：`RequestModification` 发起追加式修改请求，`ApproveModification` 批准或拒绝，旧版本标记 `DEPRECATED`，不覆盖
4. **锁定与凭证（审核人）**：`FinalizeBatch` 锁定批次、拒绝后续写入，生成唯一数字凭证 ID
5. **验证与审计（消费者/监管）**：`VerifyBatch` 重算哈希比对链上，`GetAllVersions` 查询全版本历史

## 规划目录结构

```
chain-field-guard/
├── chaincode/          # 链码（状态机核心）
├── backend/            # Express API 服务
├── frontend/           # Vue 3 前端
├── network/            # Fabric 网络配置（密钥材料不入库）
└── docs/               # 设计与部署文档
```

## 当前状态

🚧 开发中 —— 阶段规划见 [docs/](docs/)（环境搭建 → 链码 → 后端 API → 前端 → 串联演示）。
