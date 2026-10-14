package agrichain

// =============================================================================
// 单元测试基础设施(非测试用例本身):
//   - 生成带 role 属性的 ECDSA 测试证书(role 注入证书 Subject OU,Fabric cid
//     包支持 OU 形式的属性回退解析,与真实 CA 签发的扩展属性行为一致)
//   - 构造带调用者身份的 MockStub(contractapi mock 环境,不依赖真实网络)
//   - 预置批次状态、发起链码调用、读取最终状态的辅助函数
// 测试用例见 smartcontract_test.go,运行方式:
//   cd chaincode/agrichain && go test -v ./...
// =============================================================================

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"strconv"
	"testing"
	"time"

	"github.com/golang/protobuf/proto"
	"github.com/hyperledger/fabric-chaincode-go/shimtest"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
	// 注意:依赖树(fabric-chaincode-go v0.0.0-20230731)统一使用旧版
	// fabric-protos-go,若混入 fabric-protos-go-apiv2 会导致 protobuf
	// 消息名全局重复注册而 panic。
	"github.com/hyperledger/fabric-protos-go/msp"
)

// ---------------------------------------------------------------------------
// 身份与证书
// ---------------------------------------------------------------------------

// testIdentity 表示一个测试身份:私钥(用于签名)与序列化后的 Creator(用于
// 设置 MockStub 的调用者)。
type testIdentity struct {
	key     *ecdsa.PrivateKey // 身份私钥(核对人签名用)
	creator []byte            // SerializedIdentity{mspID, certPEM} 的 protobuf 字节
}

// newTestIdentity 生成自签名 ECDSA P-256 测试证书,并把 role 属性写入证书
// 扩展 OID 1.2.3.4.5.6.7.8.1(Fabric 属性扩展,值为 JSON {"attrs":{"role":...}},
// 与 Fabric CA 签发角色属性的方式一致,链码 AssertAttributeValue 可解析)。
// role 传空串表示无角色身份。
// 返回的身份用于 stub.Creator。
func newTestIdentity(t *testing.T, mspID string, role string) *testIdentity {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成 ECDSA 私钥失败: %v", err)
	}

	// 证书模板:属性写进 Fabric 属性扩展(与 --id.attrs '"role=xx:ecert"' 等价)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			CommonName: role,
		},
		NotBefore: time.Now().Add(-time.Hour),
		NotAfter:  time.Now().Add(time.Hour * 24),
		KeyUsage:  x509.KeyUsageDigitalSignature,
	}
	if role == "" {
		template.Subject.CommonName = "anonymous"
	} else {
		template.ExtraExtensions = []pkix.Extension{
			{
				Id:    asn1.ObjectIdentifier{1, 2, 3, 4, 5, 6, 7, 8, 1},
				Value: []byte(fmt.Sprintf(`{"attrs":{"role":%q}}`, role)),
			},
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("生成测试证书失败: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})

	// Creator = SerializedIdentity{Mspid, IdBytes(certPEM)} 的 protobuf 序列化
	si := &msp.SerializedIdentity{Mspid: mspID, IdBytes: certPEM}
	creator, err := proto.Marshal(si)
	if err != nil {
		t.Fatalf("序列化身份失败: %v", err)
	}
	return &testIdentity{key: key, creator: creator}
}

// ---------------------------------------------------------------------------
// MockStub 构造与调用
// ---------------------------------------------------------------------------

// newStubWithIdentity 创建 MockStub:开启一次"交易"(设置交易时间戳)并指定
// 调用者身份。之后可直接 stub.PutState 预置状态,再用 invoke 调用链码函数。
// 注:shimtest.NewMockStub 需要 shim.Chaincode 接口,而 contractapi 合约
// 需经 contractapi.NewChaincode 包装后才能满足该接口。
func newStubWithIdentity(t *testing.T, id *testIdentity) *shimtest.MockStub {
	t.Helper()
	cc, err := contractapi.NewChaincode(&SmartContract{})
	if err != nil {
		t.Fatalf("构造链码失败: %v", err)
	}
	stub := shimtest.NewMockStub("agrichain", cc)
	stub.MockTransactionStart("tx-test") // 设置 TxID 与 TxTimestamp(当前时间)
	stub.Creator = id.creator
	return stub
}

// invoke 以指定调用者身份发起一次链码函数调用(不重置交易时间戳与状态)。
// 返回响应状态码(shim.OK=200 表示成功)、错误信息与返回负载。
func invoke(stub *shimtest.MockStub, fn string, args ...string) (int32, string, []byte) {
	invokeArgs := [][]byte{[]byte(fn)}
	for _, a := range args {
		invokeArgs = append(invokeArgs, []byte(a))
	}
	// 第三个参数 SignedProposal 传 nil:链码只依赖 stub.Creator 解析调用者身份
	res := stub.MockInvokeWithSignedProposal("tx-test", invokeArgs, nil)
	return res.Status, res.Message, res.Payload
}

// mustInvokeOK 断言调用成功并返回负载;失败时直接让测试失败并打印错误信息。
func mustInvokeOK(t *testing.T, stub *shimtest.MockStub, fn string, args ...string) []byte {
	t.Helper()
	status, msg, payload := invoke(stub, fn, args...)
	if status != 200 {
		t.Fatalf("调用 %s(%v) 应成功,实际失败: %s", fn, args, msg)
	}
	return payload
}

// mustInvokeFail 断言调用被拒绝(用于越权/状态机测试),并返回错误信息。
func mustInvokeFail(t *testing.T, stub *shimtest.MockStub, fn string, args ...string) string {
	t.Helper()
	status, msg, _ := invoke(stub, fn, args...)
	if status == 200 {
		t.Fatalf("调用 %s(%v) 应被拒绝,实际却成功了", fn, args)
	}
	return msg
}

// ---------------------------------------------------------------------------
// 状态预置与读取
// ---------------------------------------------------------------------------

// seedBatch 把批次对象直接写入 MockStub 世界状态(模拟此前交易已上链的状态,
// 用于测试各状态机迁移的"前置状态")。若上一次 invoke 已结束交易(TxID 被清
// 空),则先重新开启交易再写入。
func seedBatch(t *testing.T, stub *shimtest.MockStub, batch *ProductBatch) {
	t.Helper()
	if stub.TxID == "" {
		stub.MockTransactionStart("tx-test")
	}
	raw, err := json.Marshal(batch)
	if err != nil {
		t.Fatalf("序列化预置批次失败: %v", err)
	}
	if err := stub.PutState(batch.BatchId, raw); err != nil {
		t.Fatalf("预置批次状态失败: %v", err)
	}
}

// stateBatch 读取 MockStub 世界状态中的批次(链码写入后的最终状态)。
func stateBatch(t *testing.T, stub *shimtest.MockStub, batchId string) *ProductBatch {
	t.Helper()
	raw, ok := stub.State[batchId]
	if !ok || raw == nil {
		t.Fatalf("世界状态中不存在批次 %s", batchId)
	}
	var batch ProductBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		t.Fatalf("反序列化批次 %s 失败: %v", batchId, err)
	}
	return &batch
}

// ---------------------------------------------------------------------------
// 预置批次工厂(各状态)
// ---------------------------------------------------------------------------

// sampleBatch 构建一个指定状态的批次,供各状态机迁移测试作为前置状态。
func sampleBatch(batchId string, status string) *ProductBatch {
	return &ProductBatch{
		BatchId:        batchId,
		Status:         status,
		CurrentVersion: 1,
		Versions: []BatchVersion{
			{
				Version:    1,
				Cid:        "QmSampleCidV1",
				Sha256:     "aaaabbbbccccdddd",
				AnchoredBy: "operator",
				AnchoredAt: "2026-01-01T00:00:00Z",
				Status:     VersionActive,
			},
		},
		Signatures: []string{},
	}
}

// ---------------------------------------------------------------------------
// 签名(核对人侧,模拟后端 node:crypto 行为)
// ---------------------------------------------------------------------------

// signForBatch 用私钥对签名数据包 <kind>|<batchId>|<cid>|<txSeconds> 做 SHA-256 后
// ECDSA P-256 签名(ASN.1 DER),hex 编码返回 —— 与后端签名、链码验签完全一致。
// kind 为签名用途(签名通过/驳回),txSeconds 必须与 stub 交易时间戳一致
// (即 stub.TxTimestamp.GetSeconds())。
func signForBatch(t *testing.T, key *ecdsa.PrivateKey, kind, batchId, dataCid string, txSeconds int64) string {
	t.Helper()
	payload := signPayload(kind, batchId, dataCid, txSeconds)
	digest := sha256.Sum256(payload)
	sig, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatalf("生成测试签名失败: %v", err)
	}
	return hex.EncodeToString(sig)
}

// txSeconds 返回当前 MockStub 交易时间戳(Unix 秒),签名时必须使用同一值,
// 保证与链码内 GetTxTimestamp 重建的数据包一致。
func txSeconds(t *testing.T, stub *shimtest.MockStub) int64 {
	t.Helper()
	ts, err := stub.GetTxTimestamp()
	if err != nil {
		t.Fatalf("读取 MockStub 交易时间戳失败: %v", err)
	}
	return ts.GetSeconds()
}

// int64ToStr 把 Unix 秒转成字符串,作为链码 int64 参数的调用参数。
func int64ToStr(v int64) string {
	return strconv.FormatInt(v, 10)
}
