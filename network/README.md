# network/ —— 联盟链网络(三组织 test-network 改造版)

> 基于官方 fabric-samples/test-network 改造。密钥材料(CA 生成的全部证书/私钥)不入库,由脚本运行期生成,`.gitignore` 已覆盖。

## 1. 网络拓扑

| 组织 | 职责 | 节点 |
| :--- | :--- | :--- |
| Org1(org1.example.com) | 业务方:录入人 / 核对人 / 审核人 | peer0.org1.example.com(端口 7051) |
| Org2(org2.example.com) | 监管方:只读 | peer0.org2.example.com(端口 9051) |
| Orderer(orderer.example.com) | 单节点 Raft 排序 | orderer.example.com(端口 7050) |

- 通道:`agri-channel`
- 账本数据库:leveldb(默认)/ couchdb(`-s couchdb`)
- CA 端口:ca_org1=7054、ca_org2=8054、ca_orderer=9054

## 2. 业务角色身份

由 `organizations/fabric-ca/registerEnroll.sh` 在 `./network.sh up createChannel -ca` 时通过 Fabric CA 注册,身份证书携带 `role` 属性(链码据此断言权限):

| 身份 | 组织 | role 属性 | 链码内权限 |
| :--- | :--- | :--- | :--- |
| operator(录入人) | Org1 | `role=operator` | AnchorData、RequestModification |
| checker(核对人) | Org1 | `role=checker` | CounterSign、RequestModification |
| auditor(审核人) | Org1 | `role=auditor` | ApproveModification、FinalizeBatch |
| regulator(监管) | Org2 | `role=regulator` | 仅查询(VerifyBatch / GetBatch / GetAllVersions) |

生成的 MSP 路径:

- `organizations/peerOrganizations/org1.example.com/users/Operator@org1.example.com/msp`
- `organizations/peerOrganizations/org1.example.com/users/Checker@org1.example.com/msp`
- `organizations/peerOrganizations/org1.example.com/users/Auditor@org1.example.com/msp`
- `organizations/peerOrganizations/org2.example.com/users/Regulator@org2.example.com/msp`

## 3. 快速开始

```bash
cd network

# 1) 拉起网络(CA 签发证书 + 注册业务身份)+ 创建 agri-channel
./network.sh up createChannel -ca

# 2) 部署链码(Go 链码位于 ../chaincode/agrichain)
./network.sh deployCC -ccn agrichain -ccp ../chaincode/agrichain -ccl go

# 3) 清理网络
./network.sh down
```

> `deployCC` 需要 Go 1.22+ 工具链(编译链码)与已配置的 GOPROXY。

## 4. 测试用例(环境搭好后依次执行)

### 4.1 网络冒烟测试

```bash
cd network
./network.sh up createChannel -ca
```

**期望结果**:
1. `docker ps` 出现 4 个容器:`peer0.org1.example.com`、`peer0.org2.example.com`、`orderer.example.com`、`ca_org1`(及 `ca_org2`、`ca_orderer`)
2. 日志末尾输出 `Channel 'agri-channel' joined`
3. `ls organizations/peerOrganizations/org1.example.com/users/` 应含 `Operator@org1.example.com`、`Checker@org1.example.com`、`Auditor@org1.example.com`

### 4.2 角色属性验证(确认 role 已写入证书)

```bash
cd network/organizations/peerOrganizations/org1.example.com/users/Operator@org1.example.com/msp/signcerts
openssl x509 -in cert.pem -noout -text | grep -A2 "role"
```

**期望结果**:证书扩展中能看到 `role` 属性值为 `operator`(其他身份同理)。

### 4.3 链码部署测试

```bash
cd network
./network.sh deployCC -ccn agrichain -ccp ../chaincode/agrichain -ccl go
```

**期望结果**:日志末尾输出 `Committed chaincode definition on channel 'agri-channel'`。

### 4.4 端到端业务流测试

见 `docs/03-部署手册.md` 的"端到端验证"章节(录入 → 签名 → 修改 → 锁定 → 验证全流程,可通过后端 API 或前端页面执行)。
