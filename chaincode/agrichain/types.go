package agrichain

// =============================================================================
// 本文件定义链码的常量与核心数据结构。
//
// 设计原则(与 docs/00-实现计划.md 一致):
//   1. 链上只存哈希与签名,文件本体存 IPFS;
//   2. 修改永远"追加"、不覆盖,旧版本标记 DEPRECATED,保证全量可审计;
//   3. 角色权限通过调用者证书中的 role 属性断言,监管方(Org2)一律只读。
// =============================================================================

// ---------------------------------------------------------------------------
// 批次状态机:INIT → ANCHORED → COUNTER_SIGNED ⇄ PENDING → FINALIZED
// ---------------------------------------------------------------------------
const (
	StatusInit          = "INIT"           // 初始状态(批次未上链时逻辑上的状态)
	StatusAnchored      = "ANCHORED"       // 已锚定:录入人写入首个数据版本
	StatusCounterSigned = "COUNTER_SIGNED" // 已核对:核对人签名通过
	StatusPending       = "PENDING"        // 修改待审核:已发起追加式修改请求
	StatusFinalized     = "FINALIZED"      // 已锁定:批次锁定并颁发数字凭证,拒绝一切写入
)

// 版本状态:同一批次可有多个版本,任一时刻仅一个 ACTIVE,其余 DEPRECATED。
const (
	VersionActive     = "ACTIVE"     // 当前生效版本
	VersionDeprecated = "DEPRECATED" // 历史版本(被修改请求批准后归档,保留可审计)
)

// ---------------------------------------------------------------------------
// 角色常量:与 network/ 中 registerEnroll.sh 注册的 role 属性一一对应。
// 链码通过 ClientIdentity.AssertAttributeValue("role", <角色>) 断言调用者身份。
// ---------------------------------------------------------------------------
const (
	RoleOperator  = "operator"  // 录入人:AnchorData、RequestModification
	RoleChecker   = "checker"   // 核对人:CounterSign、RequestModification
	RoleAuditor   = "auditor"   // 审核人:ApproveModification、FinalizeBatch
	RoleRegulator = "regulator" // 监管方:仅查询
)

// 组织 MSP ID:与 network/configtx/configtx.yaml 中的组织 ID 一致。
const (
	Org1MSP = "Org1MSP" // 业务方(operator/checker/auditor)
	Org2MSP = "Org2MSP" // 监管方(regulator,链码内限制只读)
)

// 交易时间戳容差(秒):签名时间戳与链上交易时间的最大允许偏差。
const TimestampToleranceSeconds = 600

// 风险等级(由风险分派生,链上唯一权威;AI 预检存证使用):
//   0-29 NORMAL(正常)/ 30-59 WARN(关注)/ 60-100 HIGH(高风险)
const (
	RiskLevelNormal = "NORMAL"
	RiskLevelWarn   = "WARN"
	RiskLevelHigh   = "HIGH"
)

// SignPayloadFormat 定义核对人签名数据包的拼接规则(前后端约定一致,不可随意改动):
//   <batchId>|<当前版本CID>|<客户端签名时间戳(Unix 秒)>
// 后端(node:crypto)与链码必须按同一规则重建数据包,否则链上验签失败。
// 时间戳由后端在签名时刻取本机 Unix 秒(随交易作为参数上链),链码校验其与
// 链上交易时间戳(stub.GetTxTimestamp)的偏差在容差内 —— 既避免客户端无法
// 预知链上时间戳的跨秒问题,又防止旧签名重放。
const SignPayloadFormat = "%s|%s|%d"

// ---------------------------------------------------------------------------
// 链上数据结构
// ---------------------------------------------------------------------------

// BatchVersion 表示批次的一个数据版本(追加式存储,永不覆盖)。
type BatchVersion struct {
	Version    int    `json:"version"`    // 版本号,从 1 递增
	Cid        string `json:"cid"`        // 文件在 IPFS 上的内容标识符
	Sha256     string `json:"sha256"`     // 文件内容的 SHA-256 哈希(链上存哈希,不存原文)
	AnchoredBy string `json:"anchoredBy"` // 该版本由哪个身份(证书主体)写入
	AnchoredAt string `json:"anchoredAt"` // 写入时间(RFC3339,取自链码交易时间戳)
	Status     string `json:"status"`     // ACTIVE(当前生效)/ DEPRECATED(历史归档)
}

// PendingModification 表示一笔待审核的追加式修改请求。
type PendingModification struct {
	NewCid      string `json:"newCid"`      // 新版本文件 CID
	NewSha256   string `json:"newSha256"`   // 新版本文件哈希
	Reason      string `json:"reason"`      // 修改原因(审计留痕)
	RequestedBy string `json:"requestedBy"` // 发起人(证书主体)
}

// AICheck 表示一次 AI 预检的链上存证(链下 AI 分析、链上锚定摘要与哈希)。
// 设计原则(与 AI 异常检测架构一致):
//   - AI 结论作为独立附加证据存证,不覆盖链上任何业务数据、不改变状态机;
//   - 完整分析报告存 IPFS(输入数据/阈值/结论明细),链上只锚定 reportCid + reportHash;
//   - 监管方可依据 reportHash 追溯 AI 在什么时间(checkedAt)、基于什么数据
//     (报告原文在 reportCid)、用什么模型(modelVersion)、做出什么判断
//     (riskScore/riskLevel/flags)。
type AICheck struct {
	ReportCid    string   `json:"reportCid"`    // AI 分析报告在 IPFS 的 CID(指向完整报告)
	ReportHash   string   `json:"reportHash"`   // AI 分析报告的 SHA-256 哈希(链上锚点,防篡改)
	RiskScore    int      `json:"riskScore"`    // 风险评分 0-100(0=无风险)
	RiskLevel    string   `json:"riskLevel"`    // 风险等级 NORMAL/WARN/HIGH(链码由评分派生)
	Flags        []string `json:"flags"`        // 异常项标记(如农残超标)
	ModelVersion string   `json:"modelVersion"` // AI 模型/规则引擎版本(可追溯模型迭代)
	CheckedBy    string   `json:"checkedBy"`    // 触发预检的身份(证书主体)
	CheckedAt    string   `json:"checkedAt"`    // 预检时间(RFC3339,链码交易时间戳)
}

// ProductBatch 表示一个农产品检验批次,以 batchId 为唯一键存在链上。
type ProductBatch struct {
	BatchId             string               `json:"batchId"`             // 批次号(业务主键,链上状态键)
	Status              string               `json:"status"`              // 批次状态机当前状态
	Versions            []BatchVersion       `json:"versions"`            // 全部数据版本(追加式,含历史 DEPRECATED 版本)
	CurrentVersion      int                  `json:"currentVersion"`      // 当前生效版本号
	Signatures          []string             `json:"signatures"`          // 核对人签名(hex 编码的 ECDSA ASN.1 签名)
	PendingModification *PendingModification `json:"pendingModification"` // 待审核修改请求(nil 表示无)
	CredentialId        string               `json:"credentialId"`        // 数字凭证 ID(锁定后生成,格式 VC-<batchId>-<txId>)
	AICheck             *AICheck             `json:"aiCheck"`             // AI 预检存证(nil=未预检;锚定后、核对签名前写入)
}
