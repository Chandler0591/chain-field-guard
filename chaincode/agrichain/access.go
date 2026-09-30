package agrichain

// =============================================================================
// 本文件封装链码的访问控制辅助函数:角色断言、监管方只读限制、账本读写。
// 权限模型(双重防线):
//   1. 组织级:监管方(Org2)在链码内被无条件拒绝写操作(即使证书属性被伪造
//      匹配,只要 MSPID 是 Org2MSP 就拒绝,保证监管独立只读);
//   2. 角色级:业务方(Org1)内部按 role 属性细分 operator/checker/auditor。
// =============================================================================

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// requireRole 断言调用者证书的 role 属性等于指定角色。
// role 属性由 Fabric CA 在注册身份时写入证书(--id.attrs '"role=<角色>:ecert"'),
// 链码读取的是证书属性,而非交易参数,无法被调用方篡改。
func requireRole(ctx contractapi.TransactionContextInterface, requiredRole string) error {
	cid := ctx.GetClientIdentity()
	if err := cid.AssertAttributeValue("role", requiredRole); err != nil {
		return fmt.Errorf("权限不足:需要 role=%s 身份,当前调用者不满足(%w)", requiredRole, err)
	}
	return nil
}

// requireAnyRole 断言调用者角色属于给定角色集合之一(如修改请求允许
// operator 或 checker 发起)。逐一尝试,任一匹配即放行。
func requireAnyRole(ctx contractapi.TransactionContextInterface, allowedRoles ...string) error {
	cid := ctx.GetClientIdentity()
	for _, r := range allowedRoles {
		if err := cid.AssertAttributeValue("role", r); err == nil {
			return nil
		}
	}
	return fmt.Errorf("权限不足:需要 %v 之一身份", allowedRoles)
}

// rejectRegulatorWrite 组织级防线:监管方(Org2)一律拒绝写操作。
// 所有写函数(AnchorData/RecordAICheck/CounterSign/RequestModification/
// ApproveModification/FinalizeBatch)入口必须先调用本函数,保证监管身份只读。
func rejectRegulatorWrite(ctx contractapi.TransactionContextInterface) error {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("读取调用者 MSPID 失败: %w", err)
	}
	if mspID == Org2MSP {
		return fmt.Errorf("监管方(%s)为只读身份,禁止写操作", Org2MSP)
	}
	return nil
}

// verifySignature 用调用者证书公钥验证核对人签名:
//   - signature 为 hex 编码的 ECDSA P-256 ASN.1(DER)签名;
//   - 对 payload 做 SHA-256 后 ECDSA 验签(与后端 node:crypto 'sha256' 签名、
//     旧版 cid.Verify 的行为一致)。
//
// 说明:fabric-chaincode-go 新版 cid 包不再提供 Verify 方法,这里基于
// GetX509Certificate 自行实现,证书即调用者证书 —— 验证通过即证明签名
// 出自当前调用者私钥,不可抵赖。
func verifySignature(ctx contractapi.TransactionContextInterface, payload []byte, signatureHex string) error {
	sig, err := hex.DecodeString(signatureHex)
	if err != nil {
		return fmt.Errorf("签名不是合法 hex 编码: %w", err)
	}
	cert, err := ctx.GetClientIdentity().GetX509Certificate()
	if err != nil {
		return fmt.Errorf("获取调用者证书失败: %w", err)
	}
	if cert == nil {
		return fmt.Errorf("调用者未提供 X509 证书")
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return fmt.Errorf("调用者证书公钥非 ECDSA(实际 %T),无法验证签名", cert.PublicKey)
	}
	digest := sha256.Sum256(payload)
	if !ecdsa.VerifyASN1(pub, digest[:], sig) {
		return fmt.Errorf("签名验证失败:签名与数据包不匹配")
	}
	return nil
}

// getBatch 从世界状态读取批次;键不存在时返回 nil(由调用方决定语义)。
func getBatch(ctx contractapi.TransactionContextInterface, batchId string) (*ProductBatch, error) {
	raw, err := ctx.GetStub().GetState(batchId)
	if err != nil {
		return nil, fmt.Errorf("读取批次 %s 失败: %w", batchId, err)
	}
	if raw == nil {
		return nil, nil
	}
	var batch ProductBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		return nil, fmt.Errorf("反序列化批次 %s 失败(数据可能损坏): %w", batchId, err)
	}
	return &batch, nil
}

// mustGetBatch 读取批次,不存在时直接报错(查询类函数使用)。
func mustGetBatch(ctx contractapi.TransactionContextInterface, batchId string) (*ProductBatch, error) {
	batch, err := getBatch(ctx, batchId)
	if err != nil {
		return nil, err
	}
	if batch == nil {
		return nil, fmt.Errorf("批次 %s 不存在", batchId)
	}
	return batch, nil
}

// putBatch 将批次写回世界状态(键为 batchId,值为 JSON)。
func putBatch(ctx contractapi.TransactionContextInterface, batch *ProductBatch) error {
	raw, err := json.Marshal(batch)
	if err != nil {
		return fmt.Errorf("序列化批次 %s 失败: %w", batch.BatchId, err)
	}
	return ctx.GetStub().PutState(batch.BatchId, raw)
}

// currentVersion 返回批次当前生效版本;若版本数组异常则报错(防御性检查)。
func currentVersion(batch *ProductBatch) (*BatchVersion, error) {
	if batch.CurrentVersion <= 0 || batch.CurrentVersion > len(batch.Versions) {
		return nil, fmt.Errorf("批次 %s 版本数据异常:currentVersion=%d,versions=%d",
			batch.BatchId, batch.CurrentVersion, len(batch.Versions))
	}
	return &batch.Versions[batch.CurrentVersion-1], nil
}

// signPayload 重建核对人签名的数据包。
// 规则:batchId + "|" + 当前版本 CID + "|" + 交易时间戳(Unix 秒)。
// 后端签名时必须使用完全相同的数据,链上验证才能通过。
// 注意:payload 规则是安全契约的一部分,变更会导致历史签名无法验证。
func signPayload(batchId, dataCid string, txSeconds int64) []byte {
	return []byte(fmt.Sprintf(SignPayloadFormat, batchId, dataCid, txSeconds))
}

// riskLevelOf 由风险评分派生风险等级(与后端 ai 服务规则完全一致,
// 链上以分值为唯一权威):0-29 NORMAL / 30-59 WARN / 60-100 HIGH。
// AI 预检存证(RecordAICheck)时由链码派生并写入,避免前后端口径不一致。
func riskLevelOf(score int) string {
	if score >= 60 {
		return RiskLevelHigh
	}
	if score >= 30 {
		return RiskLevelWarn
	}
	return RiskLevelNormal
}
