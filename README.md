# 链田守护 · ChainField Guard

> 基于联盟链的农产品质量安全检验与数字凭证管理系统

## 项目定位

面向农产品质量安全场景，构建一个"数据可信锚定 → 多角色签名 → 修改可审计 → 数字凭证颁发"的全流程管理系统。链上只存哈希与签名，文件本体存于 IPFS，通过联盟链（Hyperledger Fabric）保证数据不可篡改、操作不可抵赖、历史全量可查。

## 技术栈

| 层 | 技术选型 |
| :--- | :--- |
| 联盟链 | Hyperledger Fabric 2.5（多组织、多角色权限） |
| 链下存储 | IPFS（存文件，链上存 CID + SHA-256） |
| 链码 | Go(状态机 + 多版本追加 + AI 预检存证) |
| 后端 | Node.js + Express(Fabric Gateway 模式) |
| AI 异常检测 | 链下规则引擎(可插拔替换真实模型),结论哈希上链存证 |
| 前端 | Vue 3（角色切换面板 + 各环节操作页） |

## 核心业务流程

批次状态机：`INIT → ANCHORED → COUNTER_SIGNED ⇄ PENDING → FINALIZED`

1. **数据锚定(录入人)**:文件上传 IPFS 得 CID,计算 SHA-256,调用 `AnchorData` 写入链上
2. **AI 预检(录入人,链下智能 + 链上存证)**:规则引擎分析结构化检测数据(农残/铅/水分),完整报告存 IPFS,结论哈希由 `RecordAICheck` 上链 —— 不改变状态机,仅作辅助证据
3. **二级签名(核对人)**:查看 AI 风险提示后人工复核,对数据包签名,调用 `CounterSign` 永久上链
4. **修改复核(录入人/审核人)**:`RequestModification` 发起追加式修改请求,`ApproveModification` 批准或拒绝,旧版本标记 `DEPRECATED`,不覆盖
5. **锁定与凭证(审核人)**:`FinalizeBatch` 锁定批次、拒绝后续写入,生成唯一数字凭证 ID
6. **验证与审计(消费者/监管)**:`VerifyBatch` 重算哈希比对链上,`GetAllVersions` 查询全版本历史;监管方可凭 AI 报告 CID 取回原文并核验哈希,追溯 AI 判断依据

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

✅ 阶段 1~5 代码已全部交付(网络 / 链码 / 后端 / 前端 / 演示脚本与部署手册),并已加入 **AI 异常检测环节**(链下智能分析 + 结论哈希上链存证,辅助人工决策),待你按部署手册在自建环境中跑通验证。另补充**网络配置原理导读**(组织动态扩展专题),补齐三阶段学习路线中阶段 2 的知识缺口。

- 实现计划:[docs/00-实现计划.md](docs/00-实现计划.md)
- 环境搭建:[docs/01-环境搭建.md](docs/01-环境搭建.md)
- 链码设计:[docs/02-链码设计.md](docs/02-链码设计.md)
- 部署手册(从零部署到演示):[docs/03-部署手册.md](docs/03-部署手册.md)
- 网络配置原理导读(组织扩展专题):[docs/04-网络配置原理导读.md](docs/04-网络配置原理导读.md)
- 网络使用与测试:[network/README.md](network/README.md)
- 后端启动与测试:[backend/README.md](backend/README.md)
- 前端启动与演示:[frontend/README.md](frontend/README.md)
