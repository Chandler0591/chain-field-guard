package agrichain

// =============================================================================
// 链田守护(ChainField Guard)智能合约
//
// 实现批次状态机:INIT → ANCHORED → COUNTER_SIGNED ⇄ PENDING → FINALIZED
//
//   写操作(角色 + 状态双重校验):
//     AnchorData          operator        INIT            → ANCHORED
//     RecordAICheck       operator        ANCHORED        → (状态不变,AI 预检存证)
//     CounterSign         checker         ANCHORED        → COUNTER_SIGNED(链上验签)
//     RequestModification operator/checker COUNTER_SIGNED → PENDING
//     ApproveModification auditor         PENDING         → COUNTER_SIGNED(批准则追加版本)
//     FinalizeBatch       auditor         COUNTER_SIGNED  → FINALIZED(颁发数字凭证)
//
//   查询操作(全角色可用,含监管方):
//     GetBatch / GetAllVersions / VerifyBatch / GetCredential
//
// 权限说明:
//   - 所有写函数入口先调用 rejectRegulatorWrite(Org2 监管方一律只读),
//     再调用 requireRole 断言 role 属性(属性随证书签发,不可篡改)。
//   - 修改永远追加新版本并把旧版本标记 DEPRECATED,不覆盖历史。
// =============================================================================

import (
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// SmartContract 是链田守护合约主体,由 contractapi 框架按函数名路由调用。
type SmartContract struct {
	contractapi.Contract
}

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

// AnchorData 数据锚定(录入人):把文件 CID 与 SHA-256 哈希写入链上,创建批次
// 首个数据版本 v1,批次状态 INIT → ANCHORED。
//
//	参数:batchId 批次号(唯一键);dataCid 文件 IPFS CID;sha256 文件 SHA-256 哈希(hex)
func (s *SmartContract) AnchorData(ctx contractapi.TransactionContextInterface, batchId string, dataCid string, sha256 string) (*ProductBatch, error) {
	// 组织级防线:监管方只读
	if err := rejectRegulatorWrite(ctx); err != nil {
		return nil, err
	}
	// 角色断言:仅录入人
	if err := requireRole(ctx, RoleOperator); err != nil {
		return nil, err
	}
	// 参数校验
	if batchId == "" {
		return nil, fmt.Errorf("batchId 不能为空")
	}
	if dataCid == "" || sha256 == "" {
		return nil, fmt.Errorf("dataCid 与 sha256 均不能为空")
	}
	// 批次必须不存在(一个批次只允许锚定一次;后续变更走修改流程)
	existing, err := getBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, fmt.Errorf("批次 %s 已存在(当前状态 %s),不允许重复锚定", batchId, existing.Status)
	}

	callerID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, fmt.Errorf("读取调用者身份 ID 失败: %w", err)
	}
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return nil, fmt.Errorf("读取交易时间戳失败: %w", err)
	}
	batch := &ProductBatch{
		BatchId: batchId,
		Status:  StatusAnchored,
		Versions: []BatchVersion{
			{
				Version:    1,
				Cid:        dataCid,
				Sha256:     sha256,
				AnchoredBy: callerID,
				AnchoredAt: ts.AsTime().Format(time.RFC3339),
				Status:     VersionActive,
			},
		},
		CurrentVersion: 1,
		Signatures:     []string{},
	}
	if err := putBatch(ctx, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// CounterSign 二级签名(核对人):核对人对数据包签名后调用本函数,链码用调用者
// 证书公钥在链上验签,验签通过后批次状态 ANCHORED → COUNTER_SIGNED。
//
//	参数:batchId 批次号;signature 核对人签名(hex 编码的 ECDSA P-256 ASN.1 签名,
//	     签名对象为 batchId|当前CID|clientTimestamp,见 signPayload);
//	     clientTimestamp 核对人签名时本机 Unix 秒 —— 链码校验其与链上交易时间戳
//	     的偏差不超过 TimestampToleranceSeconds,既容忍跨秒又防旧签名重放。
//
// 注:AI 预检(RecordAICheck)不影响本函数 —— AI 结论是辅助证据,核对人签名前
// 可自行查询风险提示,是否签名仍由人工决定。
func (s *SmartContract) CounterSign(ctx contractapi.TransactionContextInterface, batchId string, signature string, clientTimestamp int64) (*ProductBatch, error) {
	if err := rejectRegulatorWrite(ctx); err != nil {
		return nil, err
	}
	if err := requireRole(ctx, RoleChecker); err != nil {
		return nil, err
	}
	if signature == "" {
		return nil, fmt.Errorf("signature 不能为空")
	}
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	// 状态机:仅 ANCHORED 状态允许核对签名
	if batch.Status != StatusAnchored {
		return nil, fmt.Errorf("批次 %s 当前状态为 %s,仅 %s 状态可核对签名", batchId, batch.Status, StatusAnchored)
	}
	ver, err := currentVersion(batch)
	if err != nil {
		return nil, err
	}
	// 容差校验:签名时间戳与链上交易时间偏差过大则拒绝(防重放)
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return nil, fmt.Errorf("读取交易时间戳失败: %w", err)
	}
	diff := ts.GetSeconds() - clientTimestamp
	if diff < 0 {
		diff = -diff
	}
	if diff > TimestampToleranceSeconds {
		return nil, fmt.Errorf("签名时间戳 %d 与链上交易时间 %d 偏差超过 %d 秒,签名无效",
			clientTimestamp, ts.GetSeconds(), TimestampToleranceSeconds)
	}
	// 重建签名数据包并用调用者证书公钥验证(签名不可抵赖、数据不可篡改)
	payload := signPayload(batchId, ver.Cid, clientTimestamp)
	if err := verifySignature(ctx, payload, signature); err != nil {
		return nil, fmt.Errorf("链上验签失败:%w", err)
	}
	batch.Status = StatusCounterSigned
	batch.Signatures = append(batch.Signatures, signature)
	if err := putBatch(ctx, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// RequestModification 发起追加式修改请求(录入人或核对人):提交新版本 CID/哈希
// 与修改原因,批次状态 COUNTER_SIGNED → PENDING,等待审核人复核。
// 本函数只登记请求,不修改任何历史版本。
//
//	参数:batchId;newCid 新版本文件 CID;newSha256 新版本哈希;reason 修改原因
func (s *SmartContract) RequestModification(ctx contractapi.TransactionContextInterface, batchId string, newCid string, newSha256 string, reason string) (*ProductBatch, error) {
	if err := rejectRegulatorWrite(ctx); err != nil {
		return nil, err
	}
	if err := requireAnyRole(ctx, RoleOperator, RoleChecker); err != nil {
		return nil, err
	}
	if newCid == "" || newSha256 == "" {
		return nil, fmt.Errorf("newCid 与 newSha256 均不能为空")
	}
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	// 状态机:仅 COUNTER_SIGNED 状态可发起修改(且不允许重复发起)
	if batch.Status != StatusCounterSigned {
		return nil, fmt.Errorf("批次 %s 当前状态为 %s,仅 %s 状态可发起修改", batchId, batch.Status, StatusCounterSigned)
	}
	if batch.PendingModification != nil {
		return nil, fmt.Errorf("批次 %s 已存在待审核的修改请求,请先由审核人处理", batchId)
	}
	callerID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, fmt.Errorf("读取调用者身份 ID 失败: %w", err)
	}
	batch.PendingModification = &PendingModification{
		NewCid:      newCid,
		NewSha256:   newSha256,
		Reason:      reason,
		RequestedBy: callerID,
	}
	batch.Status = StatusPending
	if err := putBatch(ctx, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// ApproveModification 修改复核(审核人):批准或拒绝待审核的修改请求。
//   - 批准:新版本"追加"为 currentVersion+1(ACTIVE),旧版本标记 DEPRECATED,
//     状态回 COUNTER_SIGNED;历史版本保留,审计可查。
//   - 拒绝:请求作废(pendingModification 置空),状态回 COUNTER_SIGNED。
//
//	参数:batchId;approved true=批准 / false=拒绝
func (s *SmartContract) ApproveModification(ctx contractapi.TransactionContextInterface, batchId string, approved bool) (*ProductBatch, error) {
	if err := rejectRegulatorWrite(ctx); err != nil {
		return nil, err
	}
	if err := requireRole(ctx, RoleAuditor); err != nil {
		return nil, err
	}
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	// 状态机:仅 PENDING 状态可复核
	if batch.Status != StatusPending || batch.PendingModification == nil {
		return nil, fmt.Errorf("批次 %s 当前没有待审核的修改请求(状态 %s)", batchId, batch.Status)
	}
	pending := batch.PendingModification

	if approved {
		// 追加式修改:旧版本归档,新版本追加,永不覆盖
		for i := range batch.Versions {
			batch.Versions[i].Status = VersionDeprecated
		}
		callerID, err := ctx.GetClientIdentity().GetID()
		if err != nil {
			return nil, fmt.Errorf("读取调用者身份 ID 失败: %w", err)
		}
		ts, err := ctx.GetStub().GetTxTimestamp()
		if err != nil {
			return nil, fmt.Errorf("读取交易时间戳失败: %w", err)
		}
		batch.Versions = append(batch.Versions, BatchVersion{
			Version:    batch.CurrentVersion + 1,
			Cid:        pending.NewCid,
			Sha256:     pending.NewSha256,
			AnchoredBy: callerID,
			AnchoredAt: ts.AsTime().Format(time.RFC3339),
			Status:     VersionActive,
		})
		batch.CurrentVersion++
	} else {
		// 拒绝:请求作废,版本保持不变
	}
	batch.PendingModification = nil
	batch.Status = StatusCounterSigned
	if err := putBatch(ctx, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// FinalizeBatch 锁定与凭证(审核人):锁定批次并颁发唯一数字凭证,状态
// COUNTER_SIGNED → FINALIZED。凭证 ID 格式 VC-<batchId>-<txId>,txId 为本
// 交易 ID(链上唯一),因此凭证 ID 全局唯一且可在账本中回溯。锁定后拒绝一切写入。
//
//	参数:batchId
func (s *SmartContract) FinalizeBatch(ctx contractapi.TransactionContextInterface, batchId string) (*ProductBatch, error) {
	if err := rejectRegulatorWrite(ctx); err != nil {
		return nil, err
	}
	if err := requireRole(ctx, RoleAuditor); err != nil {
		return nil, err
	}
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	// 状态机:仅 COUNTER_SIGNED(无待审核修改)状态可锁定
	if batch.Status != StatusCounterSigned {
		return nil, fmt.Errorf("批次 %s 当前状态为 %s,仅 %s 状态可锁定发证", batchId, batch.Status, StatusCounterSigned)
	}
	batch.CredentialId = fmt.Sprintf("VC-%s-%s", batchId, ctx.GetStub().GetTxID())
	batch.Status = StatusFinalized
	if err := putBatch(ctx, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// RecordAICheck AI 预检存证(录入人):触发链下 AI 服务分析批次的结构化检测数据,
// 把分析报告摘要与哈希写入链上,作为该批次的附加证据。
//
// 架构定位(链下智能 + 链上存证 + 人工决策,与 AI 异常检测设计一致):
//   - 链下智能:AI 分析在链下完成后端完成,完整报告存 IPFS,链上只锚定
//     reportCid(指针)+ reportHash(哈希)+ 摘要(评分/等级/异常项/模型版本);
//   - 链上存证:AI 结论作为独立证据存证,不覆盖任何业务数据,监管方可依据
//     reportHash 追溯 AI 何时(checkedAt)基于何数据做出何判断;
//   - 人工决策:本函数不改变批次状态机,核对人签名前可查看风险提示,
//     自行决定继续签名或发起修改 —— 最终决策权在人工与链上规则。
//
// 约束:仅 ANCHORED 状态可预检(锚定之后、核对签名之前),每批次仅一次。
//
//	参数:batchId;reportCid AI 报告 IPFS CID;reportHash AI 报告 SHA-256;
//	     riskScore 风险评分(0-100,链码校验范围并派生 riskLevel);
//	     flags 异常项标记(JSON 数组,如 ["农残超标"]);modelVersion 模型版本
func (s *SmartContract) RecordAICheck(ctx contractapi.TransactionContextInterface, batchId string, reportCid string, reportHash string, riskScore int, flags []string, modelVersion string) (*ProductBatch, error) {
	if err := rejectRegulatorWrite(ctx); err != nil {
		return nil, err
	}
	if err := requireRole(ctx, RoleOperator); err != nil {
		return nil, err
	}
	// 参数校验
	if reportCid == "" || reportHash == "" || modelVersion == "" {
		return nil, fmt.Errorf("reportCid、reportHash、modelVersion 均不能为空")
	}
	if riskScore < 0 || riskScore > 100 {
		return nil, fmt.Errorf("riskScore 必须在 0-100 之间,实际 %d", riskScore)
	}
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	// 状态机:仅 ANCHORED 状态可预检(锚定之后、核对签名之前)
	if batch.Status != StatusAnchored {
		return nil, fmt.Errorf("批次 %s 当前状态为 %s,仅 %s 状态可执行 AI 预检", batchId, batch.Status, StatusAnchored)
	}
	// 每批次仅允许一次预检(结论是证据,不允许覆盖)
	if batch.AICheck != nil {
		return nil, fmt.Errorf("批次 %s 已完成 AI 预检,不允许重复执行", batchId)
	}
	callerID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, fmt.Errorf("读取调用者身份 ID 失败: %w", err)
	}
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return nil, fmt.Errorf("读取交易时间戳失败: %w", err)
	}
	batch.AICheck = &AICheck{
		ReportCid:    reportCid,
		ReportHash:   reportHash,
		RiskScore:    riskScore,
		RiskLevel:    riskLevelOf(riskScore),
		Flags:        flags,
		ModelVersion: modelVersion,
		CheckedBy:    callerID,
		CheckedAt:    ts.AsTime().Format(time.RFC3339),
	}
	if err := putBatch(ctx, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// ---------------------------------------------------------------------------
// 查询操作(全角色可用,含监管方 regulator)
// ---------------------------------------------------------------------------

// GetBatch 查询批次详情(当前状态、当前版本、凭证 ID 等)。
func (s *SmartContract) GetBatch(ctx contractapi.TransactionContextInterface, batchId string) (*ProductBatch, error) {
	return mustGetBatch(ctx, batchId)
}

// GetAllVersions 查询批次全版本历史(含 DEPRECATED 版本),用于审计追溯。
func (s *SmartContract) GetAllVersions(ctx contractapi.TransactionContextInterface, batchId string) ([]BatchVersion, error) {
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	return batch.Versions, nil
}

// VerifyBatch 验证批次数据哈希:将外部提供的 SHA-256 与链上当前生效版本的
// 哈希比对,返回 "MATCH" 或 "MISMATCH"。消费者/监管方可借此核验文件未被篡改。
func (s *SmartContract) VerifyBatch(ctx contractapi.TransactionContextInterface, batchId string, sha256 string) (string, error) {
	if sha256 == "" {
		return "", fmt.Errorf("sha256 不能为空")
	}
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return "", err
	}
	ver, err := currentVersion(batch)
	if err != nil {
		return "", err
	}
	if ver.Sha256 == sha256 {
		return "MATCH", nil
	}
	return "MISMATCH", nil
}

// GetCredential 查询批次数字凭证。仅 FINALIZED 状态的批次持有凭证,
// 返回凭证 ID(格式 VC-<batchId>-<txId>);未锁定则返回空并报错。
func (s *SmartContract) GetCredential(ctx contractapi.TransactionContextInterface, batchId string) (string, error) {
	batch, err := mustGetBatch(ctx, batchId)
	if err != nil {
		return "", err
	}
	if batch.Status != StatusFinalized {
		return "", fmt.Errorf("批次 %s 尚未锁定(状态 %s),无数字凭证", batchId, batch.Status)
	}
	return batch.CredentialId, nil
}
