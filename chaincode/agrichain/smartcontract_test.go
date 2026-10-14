package agrichain

// =============================================================================
// 链码单元测试用例(mock 环境,无需真实 Fabric 网络)
//
// 运行方式:
//   cd chaincode/agrichain && go test -v ./...
//
// 覆盖维度:
//   1. 状态机全流转(锚定 → 核对签名 → 修改请求 → 修改复核 → 锁定发证)
//   2. 角色越权拒绝(operator/checker/auditor 各自边界 + 监管方只读)
//   3. 链上验签(合法签名通过、篡改签名拒绝)
//   4. 追加式修改(旧版本 DEPRECATED 保留、不覆盖)
//   5. AI 预检存证(结论上链、不改状态机、风险等级映射)
// =============================================================================

import (
	"encoding/json"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// 1. AnchorData 数据锚定(录入人)
// ---------------------------------------------------------------------------

// TestAnchorData_HappyPath:录入人首次锚定 → 状态 ANCHORED,版本 v1 生效。
func TestAnchorData_HappyPath(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)

	payload := mustInvokeOK(t, stub, "AnchorData", "B001", "QmCidV1", "sha256-001")

	var out ProductBatch
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("返回负载应为 ProductBatch JSON: %v", err)
	}
	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusAnchored {
		t.Fatalf("状态应为 %s,实际 %s", StatusAnchored, batch.Status)
	}
	if batch.CurrentVersion != 1 || len(batch.Versions) != 1 {
		t.Fatalf("应只有 1 个版本且 currentVersion=1,实际 version=%d len=%d",
			batch.CurrentVersion, len(batch.Versions))
	}
	v1 := batch.Versions[0]
	if v1.Cid != "QmCidV1" || v1.Sha256 != "sha256-001" || v1.Status != VersionActive {
		t.Fatalf("版本 v1 内容不符: %+v", v1)
	}
}

// TestAnchorData_WrongRole:核对人/审核人/无角色身份锚定均被拒绝。
func TestAnchorData_WrongRole(t *testing.T) {
	cases := []struct {
		name  string
		mspID string
		role  string
	}{
		{"核对人", Org1MSP, RoleChecker},
		{"审核人", Org1MSP, RoleAuditor},
		{"无角色", Org1MSP, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id := newTestIdentity(t, c.mspID, c.role)
			stub := newStubWithIdentity(t, id)
			msg := mustInvokeFail(t, stub, "AnchorData", "B001", "QmCidV1", "sha256-001")
			if !strings.Contains(msg, "权限不足") {
				t.Fatalf("错误信息应包含权限不足,实际: %s", msg)
			}
		})
	}
}

// TestAnchorData_RegulatorRejected:监管方(Org2)即使伪造 role=operator 属性,
// 组织级防线仍拒绝其写入 —— 监管只读不受角色属性影响。
func TestAnchorData_RegulatorRejected(t *testing.T) {
	// 场景 A:正常 regulator 角色
	regulator := newTestIdentity(t, Org2MSP, RoleRegulator)
	stubA := newStubWithIdentity(t, regulator)
	msgA := mustInvokeFail(t, stubA, "AnchorData", "B001", "QmCidV1", "sha256-001")
	if !strings.Contains(msgA, "只读") {
		t.Fatalf("监管方写入应报只读错误,实际: %s", msgA)
	}
	// 场景 B:监管方身份伪造业务角色属性,仍被组织级防线拦截
	fakeOperator := newTestIdentity(t, Org2MSP, RoleOperator)
	stubB := newStubWithIdentity(t, fakeOperator)
	msgB := mustInvokeFail(t, stubB, "AnchorData", "B002", "QmCidV1", "sha256-001")
	if !strings.Contains(msgB, "只读") {
		t.Fatalf("伪造角色的监管方写入仍应被拦截,实际: %s", msgB)
	}
}

// TestAnchorData_DuplicateRejected:同一批次重复锚定被拒绝(修改必须走修改流程)。
func TestAnchorData_DuplicateRejected(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	mustInvokeOK(t, stub, "AnchorData", "B001", "QmCidV1", "sha256-001")
	msg := mustInvokeFail(t, stub, "AnchorData", "B001", "QmCidV2", "sha256-002")
	if !strings.Contains(msg, "不允许重复锚定") {
		t.Fatalf("重复锚定应被拒绝,实际: %s", msg)
	}
}

// ---------------------------------------------------------------------------
// 2. CounterSign 二级签名(核对人,链上验签)
// ---------------------------------------------------------------------------

// TestCounterSign_ExpiredTimestamp:签名时间戳与链上交易时间偏差超过容差
// (TimestampToleranceSeconds)时被拒 —— 防止旧签名重放。
func TestCounterSign_ExpiredTimestamp(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))

	// 用远早于交易时间的旧时间戳签名(超出容差)
	staleTs := txSeconds(t, stub) - TimestampToleranceSeconds - 1
	staleSig := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmSampleCidV1", staleTs)
	msg := mustInvokeFail(t, stub, "CounterSign", "B001", staleSig, int64ToStr(staleTs))
	if !strings.Contains(msg, "偏差超过") {
		t.Fatalf("超容差时间戳应被拒绝,实际: %s", msg)
	}
}

// TestCounterSign_ValidSignature:核对人对当前版本数据包合法签名 → 状态
// ANCHORED → COUNTER_SIGNED,签名记录在案。
func TestCounterSign_ValidSignature(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	// 前置状态:operator 已锚定 v1(直接预置 ANCHORED 批次)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))

	// 核对人用自己私钥对 <SIGN|B001|QmSampleCidV1|clientTimestamp> 签名
	ts := txSeconds(t, stub)
	sig := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmSampleCidV1", ts)

	payload := mustInvokeOK(t, stub, "CounterSign", "B001", sig, int64ToStr(ts))
	var out ProductBatch
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("返回负载应为 ProductBatch JSON: %v", err)
	}
	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusCounterSigned {
		t.Fatalf("状态应为 %s,实际 %s", StatusCounterSigned, batch.Status)
	}
	if len(batch.Signatures) != 1 || batch.Signatures[0] != sig {
		t.Fatalf("签名应被记录,实际: %v", batch.Signatures)
	}
}

// TestCounterSign_TamperedSignature:签名内容与链上数据包不一致(篡改)时,
// 链上验签失败,状态不得推进。
func TestCounterSign_TamperedSignature(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))

	// 故意对错误的数据包(错误 CID)签名,模拟篡改
	ts := txSeconds(t, stub)
	tampered := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmTamperedCid", ts)
	msg := mustInvokeFail(t, stub, "CounterSign", "B001", tampered, int64ToStr(ts))
	if !strings.Contains(msg, "验签失败") {
		t.Fatalf("篡改签名应验签失败,实际: %s", msg)
	}
	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusAnchored {
		t.Fatalf("验签失败后状态必须保持 %s,实际 %s", StatusAnchored, batch.Status)
	}
}

// TestCounterSign_WrongRole:录入人(非核对人)签名被角色断言拒绝。
func TestCounterSign_WrongRole(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
	sig := signForBatch(t, operator.key, SignKindCounterSign, "B001", "QmSampleCidV1", txSeconds(t, stub))
	msg := mustInvokeFail(t, stub, "CounterSign", "B001", sig, int64ToStr(txSeconds(t, stub)))
	if !strings.Contains(msg, "权限不足") {
		t.Fatalf("非核对人签名应被拒绝,实际: %s", msg)
	}
}

// TestCounterSign_WrongState:批次仍为 INIT(不存在)或已核对/待审核时,签名被拒。
func TestCounterSign_WrongState(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	cases := []struct {
		name   string
		status string
		seeded bool // 是否预置批次(INIT 场景批次不存在)
	}{
		{"批次不存在(INIT)", StatusInit, false},
		{"已核对过(COUNTER_SIGNED)", StatusCounterSigned, true},
		{"修改待审核中(PENDING)", StatusPending, true},
		{"已锁定(FINALIZED)", StatusFinalized, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stub := newStubWithIdentity(t, checker)
			if c.seeded {
				seedBatch(t, stub, sampleBatch("B001", c.status))
			}
			ts := txSeconds(t, stub)
			sig := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmSampleCidV1", ts)
			msg := mustInvokeFail(t, stub, "CounterSign", "B001", sig, int64ToStr(ts))
			// 批次不存在时报"不存在",状态不符时报"仅 xxx 状态可核对签名"
			if !strings.Contains(msg, "仅") && !strings.Contains(msg, "不存在") {
				t.Fatalf("错误状态应被拒绝并提示状态要求,实际: %s", msg)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 3. RequestModification 发起追加式修改请求(录入人/核对人)
// ---------------------------------------------------------------------------

// TestRequestModification_AllowedRoles:录入人与核对人均可发起修改,状态
// COUNTER_SIGNED → PENDING,请求内容完整留痕。
func TestRequestModification_AllowedRoles(t *testing.T) {
	for _, role := range []string{RoleOperator, RoleChecker} {
		t.Run("role="+role, func(t *testing.T) {
			id := newTestIdentity(t, Org1MSP, role)
			stub := newStubWithIdentity(t, id)
			seedBatch(t, stub, sampleBatch("B001", StatusCounterSigned))

			mustInvokeOK(t, stub, "RequestModification", "B001", "QmCidV2", "sha256-002", "检验数据勘误")

			batch := stateBatch(t, stub, "B001")
			if batch.Status != StatusPending {
				t.Fatalf("状态应为 %s,实际 %s", StatusPending, batch.Status)
			}
			p := batch.PendingModification
			if p == nil || p.NewCid != "QmCidV2" || p.NewSha256 != "sha256-002" || p.Reason != "检验数据勘误" {
				t.Fatalf("修改请求内容不符: %+v", p)
			}
		})
	}
}

// TestRequestModification_WrongRole:审核人发起修改被拒绝(审核人只做复核)。
func TestRequestModification_WrongRole(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, sampleBatch("B001", StatusCounterSigned))
	msg := mustInvokeFail(t, stub, "RequestModification", "B001", "QmCidV2", "sha256-002", "x")
	if !strings.Contains(msg, "权限不足") {
		t.Fatalf("审核人发起修改应被拒绝,实际: %s", msg)
	}
}

// TestRequestModification_WrongState:非 COUNTER_SIGNED 状态发起修改被拒绝。
func TestRequestModification_WrongState(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored)) // 未核对,不允许修改
	msg := mustInvokeFail(t, stub, "RequestModification", "B001", "QmCidV2", "sha256-002", "x")
	if !strings.Contains(msg, "仅") {
		t.Fatalf("错误状态发起修改应被拒绝,实际: %s", msg)
	}
}

// TestRequestModification_DuplicatePending:已有待审核请求时重复发起被拒绝
// (含两种拦截路径:状态机拦截 PENDING 状态,与防御性的请求重复检查)。
func TestRequestModification_DuplicatePending(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)

	// 场景 A:正常发起一次修改后(PENDING),再次发起被状态机拦截
	stub := newStubWithIdentity(t, operator)
	seedBatch(t, stub, sampleBatch("B001", StatusCounterSigned))
	mustInvokeOK(t, stub, "RequestModification", "B001", "QmCidV2", "sha256-002", "原因1")
	msg := mustInvokeFail(t, stub, "RequestModification", "B001", "QmCidV3", "sha256-003", "原因2")
	if !strings.Contains(msg, "仅") {
		t.Fatalf("PENDING 状态下重复发起修改应被拒绝,实际: %s", msg)
	}

	// 场景 B:数据异常场景(状态与请求不一致)触发防御性重复请求检查
	stubB := newStubWithIdentity(t, operator)
	abnormal := sampleBatch("B002", StatusCounterSigned)
	abnormal.PendingModification = &PendingModification{NewCid: "QmCidV2", NewSha256: "sha256-002"}
	seedBatch(t, stubB, abnormal)
	msgB := mustInvokeFail(t, stubB, "RequestModification", "B002", "QmCidV3", "sha256-003", "原因2")
	if !strings.Contains(msgB, "待审核") {
		t.Fatalf("已存在请求时应被防御性检查拒绝,实际: %s", msgB)
	}
}

// ---------------------------------------------------------------------------
// 4. ApproveModification 修改复核(审核人)
// ---------------------------------------------------------------------------

// pendingBatch 构造 PENDING 状态、带修改请求的批次(复核测试的前置状态)。
func pendingBatch() *ProductBatch {
	batch := sampleBatch("B001", StatusPending)
	batch.PendingModification = &PendingModification{
		NewCid:      "QmCidV2",
		NewSha256:   "sha256-002",
		Reason:      "检验数据勘误",
		RequestedBy: "operator",
	}
	return batch
}

// TestApproveModification_Approved:批准后新版本 v2 追加生效,旧版本 v1 标记
// DEPRECATED 且内容保留(审计可查),状态回 COUNTER_SIGNED。
func TestApproveModification_Approved(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, pendingBatch())

	mustInvokeOK(t, stub, "ApproveModification", "B001", "true")

	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusCounterSigned {
		t.Fatalf("批准后状态应回 %s,实际 %s", StatusCounterSigned, batch.Status)
	}
	if batch.PendingModification != nil {
		t.Fatalf("批准后待审核请求应清空")
	}
	if batch.CurrentVersion != 2 || len(batch.Versions) != 2 {
		t.Fatalf("批准后应有 2 个版本且 currentVersion=2,实际 version=%d len=%d",
			batch.CurrentVersion, len(batch.Versions))
	}
	v1, v2 := batch.Versions[0], batch.Versions[1]
	if v1.Status != VersionDeprecated {
		t.Fatalf("旧版本 v1 应标记 DEPRECATED,实际 %s", v1.Status)
	}
	if v1.Cid != "QmSampleCidV1" {
		t.Fatalf("旧版本内容必须保留(审计),实际 %s", v1.Cid)
	}
	if v2.Status != VersionActive || v2.Cid != "QmCidV2" || v2.Sha256 != "sha256-002" {
		t.Fatalf("新版本 v2 内容不符: %+v", v2)
	}
}

// TestApproveModification_Rejected:拒绝后请求作废、版本不变,状态回 COUNTER_SIGNED。
func TestApproveModification_Rejected(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, pendingBatch())

	mustInvokeOK(t, stub, "ApproveModification", "B001", "false")

	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusCounterSigned {
		t.Fatalf("拒绝后状态应回 %s,实际 %s", StatusCounterSigned, batch.Status)
	}
	if batch.PendingModification != nil {
		t.Fatalf("拒绝后待审核请求应清空")
	}
	if batch.CurrentVersion != 1 || len(batch.Versions) != 1 {
		t.Fatalf("拒绝后版本不得变化,实际 version=%d len=%d",
			batch.CurrentVersion, len(batch.Versions))
	}
}

// TestApproveModification_WrongRole:核对人(非审核人)复核被拒绝。
func TestApproveModification_WrongRole(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, pendingBatch())
	msg := mustInvokeFail(t, stub, "ApproveModification", "B001", "true")
	if !strings.Contains(msg, "权限不足") {
		t.Fatalf("非审核人复核应被拒绝,实际: %s", msg)
	}
}

// ---------------------------------------------------------------------------
// 5. FinalizeBatch 锁定与凭证(审核人)
// ---------------------------------------------------------------------------

// TestFinalizeBatch_HappyPath:锁定后状态 FINALIZED,凭证 ID 格式 VC-<batchId>-<txId>。
func TestFinalizeBatch_HappyPath(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, sampleBatch("B001", StatusCounterSigned))

	payload := mustInvokeOK(t, stub, "FinalizeBatch", "B001")
	var out ProductBatch
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("返回负载应为 ProductBatch JSON: %v", err)
	}
	if out.Status != StatusFinalized {
		t.Fatalf("状态应为 %s,实际 %s", StatusFinalized, out.Status)
	}
	if !strings.HasPrefix(out.CredentialId, "VC-B001-") {
		t.Fatalf("凭证 ID 应以 VC-B001- 开头,实际: %s", out.CredentialId)
	}
}

// TestFinalizeBatch_WrongState:非 COUNTER_SIGNED 状态(如存在待审核修改)锁定被拒。
func TestFinalizeBatch_WrongState(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, pendingBatch()) // PENDING:有未处理修改,不允许锁定
	msg := mustInvokeFail(t, stub, "FinalizeBatch", "B001")
	if !strings.Contains(msg, "仅") {
		t.Fatalf("存在待审核修改时锁定应被拒绝,实际: %s", msg)
	}
}

// TestFinalized_WritesRejected:锁定后一切写操作被拒绝(凭证不可再变)。
func TestFinalized_WritesRejected(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	checker := newTestIdentity(t, Org1MSP, RoleChecker)

	// 先由审核人锁定
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, sampleBatch("B001", StatusCounterSigned))
	mustInvokeOK(t, stub, "FinalizeBatch", "B001")

	// 切换为核对人身份,再尝试各种写操作,均被拒绝
	stub.Creator = checker.creator
	ts := txSeconds(t, stub)
	sig := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmSampleCidV1", ts)
	if msg := mustInvokeFail(t, stub, "CounterSign", "B001", sig, int64ToStr(ts)); !strings.Contains(msg, "仅") {
		t.Fatalf("锁定后核对应被拒绝,实际: %s", msg)
	}
	if msg := mustInvokeFail(t, stub, "RequestModification", "B001", "QmCidV9", "sha256-009", "x"); !strings.Contains(msg, "仅") {
		t.Fatalf("锁定后修改应被拒绝,实际: %s", msg)
	}
	stub.Creator = auditor.creator // 切回审核人身份,验证重复锁定被状态机拒绝
	if msg := mustInvokeFail(t, stub, "FinalizeBatch", "B001"); !strings.Contains(msg, "仅") {
		t.Fatalf("重复锁定应被拒绝,实际: %s", msg)
	}
}

// ---------------------------------------------------------------------------
// 6. 监管方(Org2)只读能力
// ---------------------------------------------------------------------------

// TestRegulator_CanQueryButCannotWrite:监管方可执行全部查询,写操作一律被拒。
func TestRegulator_CanQueryButCannotWrite(t *testing.T) {
	// 前置:operator 锚定 + checker 签名 + auditor 锁定,构造完整 FINALIZED 批次
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	mustInvokeOK(t, stub, "AnchorData", "B001", "QmCidV1", "sha256-001")
	seedFinalized := stateBatch(t, stub, "B001")
	seedFinalized.Status = StatusCounterSigned
	seedBatch(t, stub, seedFinalized)

	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub.Creator = auditor.creator
	mustInvokeOK(t, stub, "FinalizeBatch", "B001")

	// 切换为监管方身份,同一账本状态下验证只读
	regulator := newTestIdentity(t, Org2MSP, RoleRegulator)
	stub.Creator = regulator.creator

	// 查询全部可用
	mustInvokeOK(t, stub, "GetBatch", "B001")
	mustInvokeOK(t, stub, "GetAllVersions", "B001")
	mustInvokeOK(t, stub, "VerifyBatch", "B001", "sha256-001")
	cred := mustInvokeOK(t, stub, "GetCredential", "B001")
	// contractapi 对 string 返回值直接返回原始字节(无 JSON 引号)
	if !strings.HasPrefix(string(cred), "VC-B001-") {
		t.Fatalf("监管方应能查到凭证 ID,实际: %s", string(cred))
	}

	// 写操作全部被拒
	for _, c := range []struct {
		fn   string
		args []string
	}{
		{"AnchorData", []string{"B002", "QmCidV1", "sha256-001"}},
		{"RecordAICheck", []string{"B001", "QmAiReport", "aabb", "45", "[]", "rule-engine-v1"}},
		{"CounterSign", []string{"B001", "deadbeef", "1700000000"}},
		{"RejectCounterSign", []string{"B001", "不合格", "deadbeef", "1700000000"}},
		{"ResubmitData", []string{"B001", "QmCidV2", "sha256-002", "已整改"}},
		{"RequestModification", []string{"B001", "QmCidV2", "sha256-002", "x"}},
		{"ApproveModification", []string{"B001", "true"}},
		{"FinalizeBatch", []string{"B001"}},
	} {
		if msg := mustInvokeFail(t, stub, c.fn, c.args...); !strings.Contains(msg, "只读") {
			t.Fatalf("监管方调用 %s 应报只读错误,实际: %s", c.fn, msg)
		}
	}
}

// ---------------------------------------------------------------------------
// 7. 查询与验证类
// ---------------------------------------------------------------------------

// TestVerifyBatch_MatchMismatch:仅 FINALIZED 批次可验证 —— 哈希一致返回 MATCH,
// 不一致返回 MISMATCH;未签发状态(ANCHORED/REJECTED 等)验证被拒。
func TestVerifyBatch_MatchMismatch(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, operator)
	mustInvokeOK(t, stub, "AnchorData", "B001", "QmCidV1", "sha256-001")

	// 未签发(ANCHORED):不可对外验证
	msg := mustInvokeFail(t, stub, "VerifyBatch", "B001", "sha256-001")
	if !strings.Contains(msg, "尚未锁定签发") {
		t.Fatalf("未签发批次验证应提示不可验证,实际: %s", msg)
	}

	// 审核人锁定后(快速构造:置为 COUNTER_SIGNED 再锁定)方可验证
	pre := stateBatch(t, stub, "B001")
	pre.Status = StatusCounterSigned
	seedBatch(t, stub, pre)
	stub.Creator = auditor.creator
	mustInvokeOK(t, stub, "FinalizeBatch", "B001")

	if got := string(mustInvokeOK(t, stub, "VerifyBatch", "B001", "sha256-001")); !strings.Contains(got, "MATCH") {
		t.Fatalf("哈希一致应返回 MATCH,实际: %s", got)
	}
	if got := string(mustInvokeOK(t, stub, "VerifyBatch", "B001", "evil-hash")); !strings.Contains(got, "MISMATCH") {
		t.Fatalf("哈希不一致应返回 MISMATCH,实际: %s", got)
	}
}

// TestGetAllVersions_AuditHistory:批准修改后全版本历史完整:2 个版本、
// v1 DEPRECATED、v2 ACTIVE —— 全程可审计、无覆盖。
func TestGetAllVersions_AuditHistory(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, pendingBatch())
	mustInvokeOK(t, stub, "ApproveModification", "B001", "true")

	payload := mustInvokeOK(t, stub, "GetAllVersions", "B001")
	var versions []BatchVersion
	if err := json.Unmarshal(payload, &versions); err != nil {
		t.Fatalf("返回负载应为版本数组: %v", err)
	}
	if len(versions) != 2 {
		t.Fatalf("全版本历史应有 2 条,实际 %d", len(versions))
	}
	if versions[0].Status != VersionDeprecated || versions[1].Status != VersionActive {
		t.Fatalf("版本状态不符:v1=%s(应为 %s),v2=%s(应为 %s)",
			versions[0].Status, VersionDeprecated, versions[1].Status, VersionActive)
	}
}

// TestGetCredential_OnlyAfterFinalize:锁定前查凭证报错,锁定后返回凭证 ID。
func TestGetCredential_OnlyAfterFinalize(t *testing.T) {
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, auditor)
	seedBatch(t, stub, sampleBatch("B001", StatusCounterSigned))

	if msg := mustInvokeFail(t, stub, "GetCredential", "B001"); !strings.Contains(msg, "无数字凭证") {
		t.Fatalf("锁定前查凭证应报错,实际: %s", msg)
	}
	mustInvokeOK(t, stub, "FinalizeBatch", "B001")
	got := string(mustInvokeOK(t, stub, "GetCredential", "B001"))
	if !strings.Contains(got, "VC-B001-") {
		t.Fatalf("锁定后凭证 ID 应以 VC-B001- 开头,实际: %s", got)
	}
}

// TestGetBatch_NotFound:查询不存在的批次返回明确错误。
func TestGetBatch_NotFound(t *testing.T) {
	regulator := newTestIdentity(t, Org2MSP, RoleRegulator)
	stub := newStubWithIdentity(t, regulator)
	msg := mustInvokeFail(t, stub, "GetBatch", "NO-SUCH-BATCH")
	if !strings.Contains(msg, "不存在") {
		t.Fatalf("查询不存在批次应报不存在错误,实际: %s", msg)
	}
}

// ---------------------------------------------------------------------------
// 8. RecordAICheck AI 预检存证(录入人)
// ---------------------------------------------------------------------------

// TestRecordAICheck_HappyPath:录入人在 ANCHORED 状态触发 AI 预检,结论
// 完整留痕(哈希/评分/等级/异常项/模型版本),状态机保持不变 —— AI 只存证不决策。
func TestRecordAICheck_HappyPath(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))

	payload := mustInvokeOK(t, stub, "RecordAICheck", "B001", "QmAiReport", "aabb", "45", `["农残超标"]`, "rule-engine-v1")
	var out ProductBatch
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("返回负载应为 ProductBatch JSON: %v", err)
	}

	batch := stateBatch(t, stub, "B001")
	// 关键约束:AI 预检是辅助证据,不得推进状态机
	if batch.Status != StatusAnchored {
		t.Fatalf("AI 预检后状态必须保持 %s,实际 %s", StatusAnchored, batch.Status)
	}
	ai := batch.AICheck
	if ai == nil {
		t.Fatal("链上应记录 AI 预检结论")
	}
	if ai.ReportCid != "QmAiReport" || ai.ReportHash != "aabb" || ai.RiskScore != 45 || ai.RiskLevel != RiskLevelWarn {
		t.Fatalf("AI 存证内容不符: %+v", ai)
	}
	if len(ai.Flags) != 1 || ai.Flags[0] != "农残超标" {
		t.Fatalf("异常项标记应完整留痕,实际: %v", ai.Flags)
	}
	if ai.ModelVersion != "rule-engine-v1" || ai.CheckedBy == "" || ai.CheckedAt == "" {
		t.Fatalf("模型版本/触发人/时间必须留痕(可追溯),实际: %+v", ai)
	}
}

// TestRecordAICheck_RiskLevelMapping:风险分阈值映射 0-29→NORMAL、
// 30-59→WARN、60-100→HIGH(链码派生,链上唯一权威)。
func TestRecordAICheck_RiskLevelMapping(t *testing.T) {
	cases := []struct {
		score string
		level string
	}{
		{"0", RiskLevelNormal}, {"29", RiskLevelNormal},
		{"30", RiskLevelWarn}, {"59", RiskLevelWarn},
		{"60", RiskLevelHigh}, {"100", RiskLevelHigh},
	}
	for _, c := range cases {
		t.Run(c.score+"→"+c.level, func(t *testing.T) {
			operator := newTestIdentity(t, Org1MSP, RoleOperator)
			stub := newStubWithIdentity(t, operator)
			seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
			mustInvokeOK(t, stub, "RecordAICheck", "B001", "QmAiReport", "aabb", c.score, "[]", "rule-engine-v1")
			batch := stateBatch(t, stub, "B001")
			if batch.AICheck == nil || batch.AICheck.RiskLevel != c.level {
				t.Fatalf("评分 %s 应映射为 %s,实际 %+v", c.score, c.level, batch.AICheck)
			}
		})
	}
}

// TestRecordAICheck_WrongRole:核对人/审核人触发预检被拒绝(预检是录入人职责)。
func TestRecordAICheck_WrongRole(t *testing.T) {
	for _, role := range []string{RoleChecker, RoleAuditor} {
		t.Run("role="+role, func(t *testing.T) {
			id := newTestIdentity(t, Org1MSP, role)
			stub := newStubWithIdentity(t, id)
			seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
			msg := mustInvokeFail(t, stub, "RecordAICheck", "B001", "QmAiReport", "aabb", "45", "[]", "rule-engine-v1")
			if !strings.Contains(msg, "权限不足") {
				t.Fatalf("非录入人预检应被拒绝,实际: %s", msg)
			}
		})
	}
}

// TestRecordAICheck_WrongState:非 ANCHORED 状态(已核对/待审核/锁定/不存在)
// 预检被拒绝 —— 预检只能插入在锚定之后、核对签名之前。
func TestRecordAICheck_WrongState(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	cases := []struct {
		name   string
		status string
		seeded bool
	}{
		{"批次不存在(INIT)", StatusInit, false},
		{"已核对(COUNTER_SIGNED)", StatusCounterSigned, true},
		{"修改待审核(PENDING)", StatusPending, true},
		{"已锁定(FINALIZED)", StatusFinalized, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stub := newStubWithIdentity(t, operator)
			if c.seeded {
				seedBatch(t, stub, sampleBatch("B001", c.status))
			}
			msg := mustInvokeFail(t, stub, "RecordAICheck", "B001", "QmAiReport", "aabb", "45", "[]", "rule-engine-v1")
			if !strings.Contains(msg, "仅") && !strings.Contains(msg, "不存在") {
				t.Fatalf("错误状态预检应被拒绝并提示状态要求,实际: %s", msg)
			}
		})
	}
}

// TestRecordAICheck_ArchiveOnResubmit:整改重提后再次预检,旧结论归档到
// AIChecks 保留(证据不覆盖),最新结论写入 aiCheck —— 全程可追溯。
func TestRecordAICheck_ArchiveOnResubmit(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
	mustInvokeOK(t, stub, "RecordAICheck", "B001", "QmAiReport1", "aabb", "45", "[]", "rule-engine-v1")

	// 同一 ANCHORED 状态下再次预检(整改重提后的场景):旧结论归档,新结论生效
	mustInvokeOK(t, stub, "RecordAICheck", "B001", "QmAiReport2", "ccdd", "10", "[]", "rule-engine-v1")

	batch := stateBatch(t, stub, "B001")
	if batch.AICheck == nil || batch.AICheck.ReportCid != "QmAiReport2" {
		t.Fatalf("最新预检结论应为 QmAiReport2,实际 %+v", batch.AICheck)
	}
	if len(batch.AIChecks) != 1 || batch.AIChecks[0].ReportCid != "QmAiReport1" {
		t.Fatalf("旧结论应归档到 AIChecks 保留,实际 %+v", batch.AIChecks)
	}
	if batch.Status != StatusAnchored {
		t.Fatalf("AI 预检不改变状态机,实际 %s", batch.Status)
	}
}

// TestRecordAICheck_InvalidScore:风险分越界(-1/101)被拒绝。
func TestRecordAICheck_InvalidScore(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	for _, score := range []string{"-1", "101"} {
		t.Run("score="+score, func(t *testing.T) {
			stub := newStubWithIdentity(t, operator)
			seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
			msg := mustInvokeFail(t, stub, "RecordAICheck", "B001", "QmAiReport", "aabb", score, "[]", "rule-engine-v1")
			if !strings.Contains(msg, "0-100") {
				t.Fatalf("越界评分应被拒绝,实际: %s", msg)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 9. RejectCounterSign 核对驳回(核对人,链上验签)
// ---------------------------------------------------------------------------

// TestRejectCounterSign_HappyPath:核对人签名驳回 → 状态 REJECTED,原因与
// 驳回人留痕,驳回历史追加到 Rejections(不可覆盖)。
func TestRejectCounterSign_HappyPath(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))

	ts := txSeconds(t, stub)
	sig := signForBatch(t, checker.key, SignKindReject, "B001", "QmSampleCidV1", ts)
	payload := mustInvokeOK(t, stub, "RejectCounterSign", "B001", "农残超标,退回整改", sig, int64ToStr(ts))

	var out ProductBatch
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("返回负载应为 ProductBatch JSON: %v", err)
	}
	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusRejected {
		t.Fatalf("状态应为 %s,实际 %s", StatusRejected, batch.Status)
	}
	if len(batch.Rejections) != 1 {
		t.Fatalf("驳回历史应有 1 条,实际 %d", len(batch.Rejections))
	}
	r := batch.Rejections[0]
	if r.Reason != "农残超标,退回整改" || r.RejectedBy == "" || r.RejectedAt == "" {
		t.Fatalf("驳回记录应完整留痕,实际 %+v", r)
	}
}

// TestRejectCounterSign_EmptyReason:驳回原因必填,空原因被拒(链上需留痕)。
func TestRejectCounterSign_EmptyReason(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
	msg := mustInvokeFail(t, stub, "RejectCounterSign", "B001", "", "deadbeef", "1700000000")
	if !strings.Contains(msg, "驳回原因") {
		t.Fatalf("空原因应被拒绝,实际: %s", msg)
	}
}

// TestRejectCounterSign_WrongRole:录入人(非核对人)驳回被角色断言拒绝。
func TestRejectCounterSign_WrongRole(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
	ts := txSeconds(t, stub)
	sig := signForBatch(t, operator.key, SignKindReject, "B001", "QmSampleCidV1", ts)
	msg := mustInvokeFail(t, stub, "RejectCounterSign", "B001", "不合格", sig, int64ToStr(ts))
	if !strings.Contains(msg, "权限不足") {
		t.Fatalf("非核对人驳回应被拒绝,实际: %s", msg)
	}
}

// TestRejectCounterSign_WrongState:非 ANCHORED 状态驳回被拒(已签名/驳回/锁定)。
func TestRejectCounterSign_WrongState(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	cases := []struct {
		name   string
		status string
	}{
		{"已核对过(COUNTER_SIGNED)", StatusCounterSigned},
		{"已驳回(REJECTED)", StatusRejected},
		{"已锁定(FINALIZED)", StatusFinalized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stub := newStubWithIdentity(t, checker)
			seedBatch(t, stub, sampleBatch("B001", c.status))
			ts := txSeconds(t, stub)
			sig := signForBatch(t, checker.key, SignKindReject, "B001", "QmSampleCidV1", ts)
			msg := mustInvokeFail(t, stub, "RejectCounterSign", "B001", "不合格", sig, int64ToStr(ts))
			if !strings.Contains(msg, "仅") {
				t.Fatalf("错误状态驳回应被拒绝,实际: %s", msg)
			}
		})
	}
}

// TestRejectCounterSign_CrossKindReplay:用签名通过(SIGN)用途的签名发起驳回,
// 数据包 kind 不符 → 验签失败(防跨用途重放)。
func TestRejectCounterSign_CrossKindReplay(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, sampleBatch("B001", StatusAnchored))
	ts := txSeconds(t, stub)
	signKindSig := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmSampleCidV1", ts)
	msg := mustInvokeFail(t, stub, "RejectCounterSign", "B001", "不合格", signKindSig, int64ToStr(ts))
	if !strings.Contains(msg, "验签失败") {
		t.Fatalf("跨用途签名重放应验签失败,实际: %s", msg)
	}
}

// ---------------------------------------------------------------------------
// 10. ResubmitData 整改重提(录入人)
// ---------------------------------------------------------------------------

// TestResubmitData_HappyPath:驳回后录入人重提整改版 → 状态回 ANCHORED,
// 新版本追加生效、旧版本 DEPRECATED 保留、整改说明留痕、驳回历史不删除。
func TestResubmitData_HappyPath(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	stub := newStubWithIdentity(t, operator)
	rejected := sampleBatch("B001", StatusRejected)
	rejected.Rejections = []*Rejection{{
		Reason:     "农残超标",
		RejectedBy: "checker",
		RejectedAt: "2026-01-01T00:00:00Z",
	}}
	seedBatch(t, stub, rejected)

	mustInvokeOK(t, stub, "ResubmitData", "B001", "QmCidV2", "sha256-002", "已复检整改")

	batch := stateBatch(t, stub, "B001")
	if batch.Status != StatusAnchored {
		t.Fatalf("重提后状态应回 %s,实际 %s", StatusAnchored, batch.Status)
	}
	if batch.CurrentVersion != 2 || len(batch.Versions) != 2 {
		t.Fatalf("重提应追加版本,实际 version=%d len=%d", batch.CurrentVersion, len(batch.Versions))
	}
	v1, v2 := batch.Versions[0], batch.Versions[1]
	if v1.Status != VersionDeprecated || v1.Cid != "QmSampleCidV1" {
		t.Fatalf("旧版本应归档且内容保留,实际 %+v", v1)
	}
	if v2.Status != VersionActive || v2.Cid != "QmCidV2" || v2.Reason != "已复检整改" {
		t.Fatalf("整改版内容不符: %+v", v2)
	}
	if len(batch.Rejections) != 1 || batch.Rejections[0].Reason != "农残超标" {
		t.Fatalf("驳回历史应保留,实际 %+v", batch.Rejections)
	}
}

// TestResubmitData_WrongRole:核对人(非录入人)重提被拒。
func TestResubmitData_WrongRole(t *testing.T) {
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	stub := newStubWithIdentity(t, checker)
	seedBatch(t, stub, sampleBatch("B001", StatusRejected))
	msg := mustInvokeFail(t, stub, "ResubmitData", "B001", "QmCidV2", "sha256-002", "已整改")
	if !strings.Contains(msg, "权限不足") {
		t.Fatalf("非录入人重提应被拒绝,实际: %s", msg)
	}
}

// TestResubmitData_WrongState:非 REJECTED 状态重提被拒(未驳回不可重提)。
func TestResubmitData_WrongState(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	for _, status := range []string{StatusAnchored, StatusCounterSigned, StatusPending, StatusFinalized} {
		t.Run("status="+status, func(t *testing.T) {
			stub := newStubWithIdentity(t, operator)
			seedBatch(t, stub, sampleBatch("B001", status))
			msg := mustInvokeFail(t, stub, "ResubmitData", "B001", "QmCidV2", "sha256-002", "已整改")
			if !strings.Contains(msg, "仅") {
				t.Fatalf("非驳回状态重提应被拒绝,实际: %s", msg)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 11. 驳回-整改-重签-签发 全闭环
// ---------------------------------------------------------------------------

// TestRejectResubmitLoop_ClosedLoop:完整闭环 —— 锚定 → 预检(HIGH)→ 核对驳回 →
// 录入人整改重提 → 再次预检 → 核对重新签名 → 审核人锁定签发 → 消费者验证 MATCH,
// 驳回历史与预检历史全程可审计。
func TestRejectResubmitLoop_ClosedLoop(t *testing.T) {
	operator := newTestIdentity(t, Org1MSP, RoleOperator)
	checker := newTestIdentity(t, Org1MSP, RoleChecker)
	auditor := newTestIdentity(t, Org1MSP, RoleAuditor)
	stub := newStubWithIdentity(t, operator)

	// 1. 录入人锚定 + AI 预检(高风险)
	mustInvokeOK(t, stub, "AnchorData", "B001", "QmCidV1", "sha256-001")
	mustInvokeOK(t, stub, "RecordAICheck", "B001", "QmAiReport1", "aabb", "60", `["农残严重超标"]`, "rule-engine-v1")

	// 2. 核对人看到 HIGH 告警后签名驳回(附原因)
	stub.Creator = checker.creator
	ts := txSeconds(t, stub)
	// 注意:驳回签名对象绑定当前版本 v1 的 CID
	rejectSig := signForBatch(t, checker.key, SignKindReject, "B001", "QmCidV1", ts)
	mustInvokeOK(t, stub, "RejectCounterSign", "B001", "农残超标,退回整改", rejectSig, int64ToStr(ts))

	// 3. 驳回状态不可对外验证(不合格未签发)
	if msg := mustInvokeFail(t, stub, "VerifyBatch", "B001", "sha256-001"); !strings.Contains(msg, "驳回") {
		t.Fatalf("驳回批次验证应提示未签发,实际: %s", msg)
	}

	// 4. 录入人整改重提(v2 追加),再次预检(旧结论归档)
	stub.Creator = operator.creator
	mustInvokeOK(t, stub, "ResubmitData", "B001", "QmCidV2", "sha256-002", "已复检整改")
	mustInvokeOK(t, stub, "RecordAICheck", "B001", "QmAiReport2", "ccdd", "0", "[]", "rule-engine-v1")

	// 5. 核对人对整改版重新签名(绑定 v2 CID)
	stub.Creator = checker.creator
	ts2 := txSeconds(t, stub)
	signSig := signForBatch(t, checker.key, SignKindCounterSign, "B001", "QmCidV2", ts2)
	mustInvokeOK(t, stub, "CounterSign", "B001", signSig, int64ToStr(ts2))

	// 6. 审核人锁定签发,消费者验证 MATCH
	stub.Creator = auditor.creator
	mustInvokeOK(t, stub, "FinalizeBatch", "B001")
	if got := string(mustInvokeOK(t, stub, "VerifyBatch", "B001", "sha256-002")); !strings.Contains(got, "MATCH") {
		t.Fatalf("整改版签发后应验证 MATCH,实际: %s", got)
	}

	// 7. 全链路审计:驳回历史、预检归档、版本历史全部保留
	batch := stateBatch(t, stub, "B001")
	if len(batch.Rejections) != 1 || batch.Rejections[0].Reason != "农残超标,退回整改" {
		t.Fatalf("驳回历史应保留,实际 %+v", batch.Rejections)
	}
	if len(batch.AIChecks) != 1 || batch.AIChecks[0].RiskLevel != RiskLevelHigh {
		t.Fatalf("旧预检结论(HIGH)应归档,实际 %+v", batch.AIChecks)
	}
	if batch.AICheck == nil || batch.AICheck.RiskLevel != RiskLevelNormal {
		t.Fatalf("最新预检结论应为 NORMAL,实际 %+v", batch.AICheck)
	}
	if len(batch.Versions) != 2 || batch.Versions[0].Status != VersionDeprecated {
		t.Fatalf("版本历史应完整保留,实际 %+v", batch.Versions)
	}
}
