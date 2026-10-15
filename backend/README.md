# backend/ —— 链田守护后端(Express + Fabric Gateway + IPFS)

> 职责:按角色切换钱包身份提交链上交易、核对人链下签名(链上验签)、文件上传 IPFS。
> 代码注释详尽,测试分两层:单元测试(无需网络)+ 端到端测试(需真实环境,见第 5 节)。

## 1. 目录结构

```
backend/
├── package.json              # 依赖与脚本(ESM 项目,Node ≥ 18.12)
├── .env.example              # 环境变量模板(复制为 .env 可覆盖默认值)
├── scripts/
│   └── setup-wallet.js       # 钱包导入:network/ 的 4 个角色身份 → wallet/<角色>.id
├── src/
│   ├── server.js             # 入口:启动 HTTP 服务
│   ├── app.js                # Express 应用组装(导出 createApp 供测试复用)
│   ├── config.js             # 环境变量解析(默认值与 network/agrichain 对齐)
│   ├── middleware/role.js    # 角色解析与白名单中间件
│   ├── services/
│   │   ├── gateway.js        # fabric-gateway 封装(按角色连接/提交/评估)
│   │   ├── signer.js         # 核对人 ECDSA P-256 签名(与链码验签约定一致)
│   │   ├── ai.js             # AI 异常检测(链下规则引擎,可插拔替换真实模型)
│   │   └── ipfs.js           # kubo-rpc-client 上传/下载
│   └── routes/
│       ├── health.js         # GET /api/health 链路健康检查
│       ├── upload.js         # POST /api/upload、GET /api/ipfs/:cid
│       └── batches.js        # 批次状态机 12 个业务接口(含 AI 预检、核对驳回、整改重提)
└── test/
    ├── unit/                 # 单元测试(随时可跑,无需网络)
    │   ├── signer.test.js    # 签名模块:格式/闭环/篡改检测/DER 结构
    │   ├── ai.test.js        # AI 规则引擎:评分/阈值边界/等级映射/报告构造
    │   └── role.test.js      # 角色中间件:来源优先级/白名单/403/400
    └── e2e/
        └── api.e2e.test.js   # 端到端全流程(E2E=1 才执行,见第 5 节)
```

## 2. 启动步骤

```bash
# 0) 前置:网络已启动、链码已部署、IPFS 已启动
#   推荐一键完成:cd .. && ./scripts/envctl.sh deploy
#   (手动方式见 network/README.md:up createChannel + deployCC + docker run ipfs)

# 1) 安装依赖
cd ../backend
npm install

# 2) 初始化钱包:把 network 生成的 4 个角色身份导入 wallet/
npm run setup-wallet
#   期望输出 4 行 [OK]:operator / checker / auditor / regulator

# 3) (可选)复制环境变量模板,按需修改
cp .env.example .env

# 4) 启动服务
npm start
#   启动后先做健康检查:
curl http://127.0.0.1:3000/api/health
#   期望:{"ok":true,"data":{"status":"healthy",...}}
```

## 3. 角色与签名约定

| 角色 | 组织 | 钱包文件 | 可用接口 |
| :--- | :--- | :--- | :--- |
| operator(录入人) | Org1 | wallet/operator.id | upload、POST /batches、ai-check、resubmit、modification-request、全部查询 |
| checker(核对人) | Org1 | wallet/checker.id | upload、countersign、countersign-reject、modification-request、全部查询 |
| auditor(审核人) | Org1 | wallet/auditor.id | modification-approve、finalize、全部查询 |
| regulator(监管) | Org2 | wallet/regulator.id | 仅查询(verify/批次/版本/凭证),写接口被 403 拒绝 |

- 角色通过 `?role=xx`、请求头 `X-Role: xx` 或 JSON body 的 `role` 字段传递(优先级 query > header > body,缺省 operator)。后端据此选钱包身份;真正的权限在链码内由证书 role 属性断言。
- **核对签名数据包**:`kind + "|" + batchId + "|" + 当前版本CID + "|" + 客户端Unix秒`(kind = SIGN 核对签名 / REJECT 核对驳回,防跨用途重放),SHA-256 后 ECDSA P-256 签名(DER,hex)。后端用核对人钱包私钥签名,链码用核对人证书公钥验签,并校验时间戳偏差 ≤ 600 秒(防重放)。实现见 `src/services/signer.js`,与链码 `access.go` 严格一致,**勿改动拼接规则**。

## 4. API 一览

所有响应统一 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

| 方法 | 路径 | 允许角色 | 说明 |
| :--- | :--- | :--- | :--- |
| GET | /api/health | 任意 | 链路健康检查 |
| POST | /api/upload | operator/checker | multipart 上传(字段 file)→ { cid, sha256, size, name } |
| GET | /api/ipfs/:cid | 全部 | 按 CID 取回文件(预览/核验) |
| POST | /api/batches | operator | body { batchId, dataCid, sha256 } → 锚定,INIT→ANCHORED |
| POST | /api/batches/:id/ai-check | operator | body { origin?, produceType?, pesticideResidue, heavyMetalPb, moisturePct } → 链下 AI 分析,结论哈希上链存证(不改状态机;整改重提后可重新预检,旧结论归档) |
| GET | /api/batches/:id/ai-check | 全部 | 返回 { aiCheck, verified },verified=报告哈希是否可追溯核验 |
| POST | /api/batches/:id/countersign | checker | 后端签名并上链验签,ANCHORED→COUNTER_SIGNED |
| POST | /api/batches/:id/countersign-reject | checker | body { reason } → 后端 REJECT 用途签名 + 驳回原因上链,ANCHORED→REJECTED |
| POST | /api/batches/:id/resubmit | operator | body { newCid, newSha256, reason? } → 整改重提,REJECTED→ANCHORED(新版本追加、旧版本归档) |
| POST | /api/batches/:id/modification-request | operator/checker | body { newCid, newSha256, reason } → PENDING |
| POST | /api/batches/:id/modification-approve | auditor | body { approved: true/false } → 追加版本或作废 |
| POST | /api/batches/:id/finalize | auditor | 锁定发证 → FINALIZED,凭证 ID `VC-<batchId>-<txId>` |
| GET | /api/batches/:id | 全部 | 批次详情(状态/版本/签名/凭证) |
| GET | /api/batches/:id/versions | 全部 | 全版本历史(含 DEPRECATED,审计) |
| GET | /api/batches/:id/credential | 全部 | 数字凭证 ID(仅 FINALIZED) |
| POST | /api/verify/:id | 全部 | body { sha256 } → MATCH / MISMATCH(仅 FINALIZED 已签发批次可验证,未签发明确报错) |

curl 示例(完整业务流):

```bash
BASE=http://127.0.0.1:3000/api

# 1) 上传
curl -s -F "file=@report.txt" "$BASE/upload?role=operator"
# → {"ok":true,"data":{"cid":"Qm...","sha256":"abc...","size":123,"name":"report.txt"}}

# 2) 锚定
curl -s -X POST "$BASE/batches?role=operator" -H 'Content-Type: application/json' \
  -d '{"batchId":"B001","dataCid":"Qm...","sha256":"abc..."}'

# 2.5) AI 预检(链下分析,结论哈希上链;农残 0.03 命中警示阈值 → WARN)
curl -s -X POST "$BASE/batches/B001/ai-check?role=operator" -H 'Content-Type: application/json' \
  -d '{"origin":"山东寿光","produceType":"叶菜类","pesticideResidue":0.03,"heavyMetalPb":0.02,"moisturePct":9}'
# 查询预检结论与报告哈希核验(监管追溯)
curl -s "$BASE/batches/B001/ai-check?role=regulator"

# 3) 核对签名 / 核对驳回(附原因,状态 → REJECTED)
curl -s -X POST "$BASE/batches/B001/countersign?role=checker"
curl -s -X POST "$BASE/batches/B001/countersign-reject?role=checker" \
  -H 'Content-Type: application/json' -d '{"reason":"农残超标,退回整改"}'

# 3.5) 整改重提(驳回后:上传整改版 → REJECTED → ANCHORED)
curl -s -X POST "$BASE/batches/B001/resubmit?role=operator" \
  -H 'Content-Type: application/json' \
  -d '{"newCid":"Qm...v2","newSha256":"def...","reason":"已复检整改"}'

# 4) 发起修改 → 5) 审核批准 → 6) 锁定发证
curl -s -X POST "$BASE/batches/B001/modification-request?role=operator" \
  -H 'Content-Type: application/json' \
  -d '{"newCid":"Qm...v2","newSha256":"def...","reason":"报告更正"}'
curl -s -X POST "$BASE/batches/B001/modification-approve?role=auditor" \
  -H 'Content-Type: application/json' -d '{"approved":true}'
curl -s -X POST "$BASE/batches/B001/finalize?role=auditor"

# 7) 消费者验证 + 监管审计
curl -s -X POST "$BASE/verify/B001?role=regulator" -H 'Content-Type: application/json' -d '{"sha256":"def..."}'
curl -s "$BASE/batches/B001/versions?role=regulator"
```

## 5. 测试用例

### 5.1 单元测试(无需网络/链码,任何时候都能跑)

```bash
cd backend
npm test
```

**期望结果**:signer(12 用例)+ ai(25 用例)+ role(8 用例)共 45 用例全部通过。

| 用例 | 验证点 |
| :--- | :--- |
| buildPayload 格式 | `kind\|batchId\|cid\|timestamp` 与链码 SignPayloadFormat 一致 |
| currentTimestampSeconds | 返回当前 Unix 秒 |
| signPayload 产出 DER | hex 合法、首字节 0x30(SEQUENCE)、长度 64~80 字节 |
| 验签闭环 | 合法签名验证通过 |
| 篡改批次号/CID/时间戳/签名 | 验签全部失败(时间戳防重放) |
| 签名用途(kind)不一致 | 验签失败(核对签名不能当驳回签名复用,防跨用途重放) |
| 错误公钥 | 验签失败(签名必须出自核对人) |
| 非法 hex | 判失败而非崩溃 |
| 公钥推导 | 私钥可推导公钥且可验签 |
| AI 规则引擎正常/农残/铅/水分 | 0 分无异常;农残/铅两级阈值记 30/60 分,水分异常记 20 分 |
| AI 扩展维度(菌落总数/亚硝酸盐) | 两档阈值边界(30/60 分),可选字段缺省不报错、不参与评分 |
| AI 多项命中与封顶 | 命中累加(60+30=90),总分封顶 100 |
| AI 等级映射边界 | 29→NORMAL、30→WARN、59→WARN、60→HIGH(与链码一致) |
| AI 明细结构化 | details 含指标/检测值/单位/得分/档位(供前端逐项展示) |
| AI 报告构造 | 含输入快照/阈值/结论/引擎/模型版本,JSON 可解析(监管追溯依据) |
| AI provider 工厂 | 按配置选择规则引擎/http 模型 provider |
| AI http provider 降级 | 非 2xx/超时/非法响应/缺失评分 → 回退规则引擎并标注 degradedFrom |
| AI 评分越界收敛 | 模型返回超界评分收敛到 0-100 |
| resolveRole 优先级 | query > header > body,缺省 operator |
| requireRole 白名单 | 放行/403(监管写接口)/400(未知角色)/全角色读 |

### 5.2 端到端测试(环境搭好后运行,覆盖完整业务流)

**前置条件(缺一不可)**:

1. 网络与链码/IPFS:仓库根目录 `./scripts/envctl.sh deploy` 一键完成(或手动:`cd network && ./network.sh up createChannel -ca` + `deployCC` + `docker run ipfs`)
2. 后端:`cd backend && npm install && npm run setup-wallet`(deploy 已含这两步,可跳过)

**运行**:

```bash
cd backend
E2E=1 npm run test:e2e
```

**期望结果**(25 个用例全部通过):

| 用例 | 验证点 |
| :--- | :--- |
| 01 健康检查 | 后端 → 链上链路连通 |
| 02 IPFS 上传 | 返回 CID/SHA-256,按 CID 可原样取回 |
| 03 锚定 | operator 锚定成功,状态 ANCHORED、v1 生效 |
| 04 AI 预检 | 农残 0.03 → 30 分 WARN + 异常项,状态保持 ANCHORED(结论不推进状态机) |
| 05 AI 预检查询 | 监管方可读存证;IPFS 报告重算哈希与链上锚定一致(verified=true) |
| 05b AI 扩展维度 | 菌落总数 1e6 → 30 分 WARN(可选维度参与评分,链码无需感知) |
| 05c AI HIGH 场景 | 农残 0.15 → 60 分 HIGH;响应与查询接口均返回各维度得分明细(不入链) |
| 06 核对签名 | checker 签名上链验签通过,状态 COUNTER_SIGNED、签名留痕 |
| 07 发起修改 | 状态 PENDING,请求留痕、历史不覆盖 |
| 08 修改复核 | auditor 批准:v2 追加 ACTIVE,v1 标 DEPRECATED 且保留 |
| 09 锁定发证 | 状态 FINALIZED,凭证 ID 形如 `VC-<batchId>-<txId>` |
| 10 消费者验证 | 正确哈希 MATCH,错误哈希 MISMATCH |
| 11 监管审计 | regulator 可查批次/全版本历史/凭证 |
| 12a~12d 越权与边界 | 监管写接口 403;核对人锁定 403;锁定后写操作被链码拒绝;不存在批次 404 |
| 13a 驳回准备 | 独立批次锚定 + AI 预检 HIGH(农残严重超标) |
| 13b 核对驳回 | checker 附原因驳回 → REJECTED,原因/驳回人/时间链上留痕;REJECTED 状态消费者验证被拒(未签发,400) |
| 13b2 驳回边界 | 空驳回原因被后端拒绝(400) |
| 13c 整改重提 | operator 上传整改版重提 → ANCHORED v2,旧版本 DEPRECATED、整改说明留痕、驳回历史保留 |
| 13d 重新预检 | 整改版达标 → NORMAL,旧 HIGH 结论归档 aiChecks(不覆盖) |
| 13e~13g 重签-签发-验证 | 重新核对签名 → 锁定发证 → 整改版 MATCH、被驳回旧版 MISMATCH(驳回不是死路) |

> 未设置 `E2E=1` 时,端到端用例自动跳过并打印运行说明,不影响 `npm test`。
