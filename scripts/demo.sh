#!/usr/bin/env bash
# =============================================================================
# 链田守护 · 端到端演示脚本
#
# 作用:一条命令跑通完整业务流(录入人上传锚定 → AI 预检存证(WARN)→ HIGH
#       风险告警 → 核对驳回 → 整改重提 → 重新预检 → 重新签名 → 锁定发证 →
#       消费者验证 → 录入人发起修改 → 审核人批准 → 锁定发证 → 监管审计),
#       每步打印结果,适合演示/验收现场,也可作为"环境是否搭对"的验收用例。
#
# 前置条件(全部就绪后才能运行):
#   1. Fabric 网络已启动、链码已部署(见 network/README.md);
#   2. IPFS Kubo 容器已启动(5001 端口);
#   3. 后端已启动(backend: npm start),且 npm run setup-wallet 已完成。
#
# 运行方式(仓库根目录):
#   ./scripts/demo.sh
#   或指定后端地址:BASE_URL=http://127.0.0.1:3000 ./scripts/demo.sh
#
# 说明:脚本只依赖 curl + grep/sed(不依赖 jq);每步失败即退出并提示原因。
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API="$BASE_URL/api"

# ---- 输出辅助:带颜色的步骤标题 ----
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

step() { printf "\n${BLUE}━━━ 步骤 %s:${NC} %s\n" "$1" "$2"; }
ok()   { printf "${GREEN}  ✔ ${NC}%s\n" "$1"; }
info() { printf "${YELLOW}  → ${NC}%s\n" "$1"; }

# 调用后端 API 并断言 ok:true;返回响应体中的 data 字段
api() {
  local desc="$1"; shift
  local resp
  resp=$(curl -s "$@")
  # 断言 ok:true(后端统一响应格式 { ok:true, data:... })
  if ! grep -q '"ok":true' <<<"$resp"; then
    printf "${RED}  ✘ %s 失败!响应:${NC} %s\n" "$desc" "$resp"
    exit 1
  fi
  ok "$desc"
  echo "$resp"
}

# 从 JSON 中提取字符串字段(不含 jq 的兼容写法)
json_str() { grep -o "\"$1\":\"[^\"]*\"" <<<"$2" | head -1 | cut -d'"' -f4; }

# =============================================================================
# 0. 健康检查:确认 后端 → 链上 链路可用
# =============================================================================
step 0 "健康检查(后端 → 链上链路)"
api "健康检查通过" "$API/health"

# =============================================================================
# 1. 录入人:上传检验文件(IPFS)→ 锚定上链
# =============================================================================
step 1 "录入人(operator)上传检验文件并锚定上链"

BATCH_ID="DEMO-$(date +%s)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# 生成一份"检验报告"作为演示文件
printf '链田守护演示检验报告\n批次:%s\n生成时间:%s\n结论:农残检测合格\n' \
  "$BATCH_ID" "$(date '+%Y-%m-%d %H:%M:%S')" > "$WORK_DIR/report-v1.txt"

UPLOAD=$(api "文件上传 IPFS" -s -F "file=@$WORK_DIR/report-v1.txt" "$API/upload?role=operator")
CID_V1=$(json_str cid "$UPLOAD")
SHA_V1=$(json_str sha256 "$UPLOAD")
info "CID: $CID_V1"
info "SHA-256: $SHA_V1"

api "批次 $BATCH_ID 锚定上链(状态 ANCHORED)" \
  -s -X POST "$API/batches?role=operator" \
  -H 'Content-Type: application/json' \
  -d "{\"batchId\":\"$BATCH_ID\",\"dataCid\":\"$CID_V1\",\"sha256\":\"$SHA_V1\"}" >/dev/null

# =============================================================================
# 1.5. 录入人:AI 预检(链下智能分析,结论哈希上链存证;不改状态机)
# =============================================================================
step 1.5 "录入人(operator)触发 AI 预检(链下分析,结论哈希上链)"
# 提交结构化检测数据:农残 0.03 mg/kg 命中警示阈值 → 预期风险等级 WARN
api "AI 预检完成(风险等级 WARN:标记「农药残留超标」,状态仍为 ANCHORED)" \
  -s -X POST "$API/batches/$BATCH_ID/ai-check?role=operator" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"山东寿光","produceType":"叶菜类","pesticideResidue":0.03,"heavyMetalPb":0.02,"moisturePct":9}' >/dev/null

# =============================================================================
# 1.6. HIGH 风险场景:AI 红色告警(核对页红色风险提示)
# =============================================================================
step 1.6 "HIGH 风险场景:AI 红色告警(农残 0.15 → HIGH 60 分)"

HIGH_BATCH="DEMO-HIGH-$(date +%s)"

# 上传 + 锚定一个独立批次(不影响主演示批次)
printf '链田守护演示检验报告(HIGH 场景)\n批次:%s\n结论:待复核\n' \
  "$HIGH_BATCH" > "$WORK_DIR/report-high.txt"
UPLOAD_H=$(api "HIGH 场景文件上传 IPFS" -s -F "file=@$WORK_DIR/report-high.txt" "$API/upload?role=operator")
CID_H=$(json_str cid "$UPLOAD_H")
SHA_H=$(json_str sha256 "$UPLOAD_H")
api "HIGH 批次 $HIGH_BATCH 锚定上链" \
  -s -X POST "$API/batches?role=operator" \
  -H 'Content-Type: application/json' \
  -d "{\"batchId\":\"$HIGH_BATCH\",\"dataCid\":\"$CID_H\",\"sha256\":\"$SHA_H\"}" >/dev/null

# 农残 0.15 mg/kg 命中严重阈值 → 60 分 HIGH(与主批次 WARN 形成对比)
AI_H=$(api "AI 预检完成(农残 0.15 → HIGH 60 分,核对页红色告警)" \
  -s -X POST "$API/batches/$HIGH_BATCH/ai-check?role=operator" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"山东寿光","produceType":"叶菜类","pesticideResidue":0.15,"heavyMetalPb":0.02,"moisturePct":9}')
RISK_LEVEL=$(json_str riskLevel "$AI_H")
info "AI 风险等级: $RISK_LEVEL(核对人看到红色告警:「强烈建议人工复核或发起修改」)"

# 人工决策闭环:核对人看到红色告警后人工认定不合格 → 核对驳回(附原因上链,
# 状态 REJECTED)→ 未放行前消费者验证被拒 → 录入人整改重提(REJECTED →
# ANCHORED)→ 重新 AI 预检(旧 HIGH 结论归档)→ 重新签名 → 锁定发证 ——
# 演示"AI 辅助、人工决策"与"驳回不是死路,整改后仍可合格签发"。
step 1.7 "人工决策闭环:HIGH 告警 → 核对驳回 → 整改重提 → 重新预检 → 合格签发"

# 1) 核对人认定不合格 → 核对驳回(原因必填,链上留痕,状态 → REJECTED)
REJ=$(api "核对驳回(核对人附原因驳回,状态 → REJECTED)" \
  -s -X POST "$API/batches/$HIGH_BATCH/countersign-reject?role=checker" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"农残严重超标(0.15 mg/kg),退回整改"}')
REJ_STATUS=$(json_str status "$REJ")
info "批次状态: $REJ_STATUS(驳回原因已链上留痕)"

# 2) 未真正放行前消费者验证必须被拒(未签发数字凭证,不可对外验证)
VERIFY_REJ=$(curl -s -X POST "$API/verify/$HIGH_BATCH?role=regulator" \
  -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$SHA_H\"}")
if grep -q '"ok":false' <<<"$VERIFY_REJ"; then
  ok "REJECTED 状态消费者验证被正确拒绝(未签发数字凭证,不可对外验证)"
else
  printf "${RED}  ✘ REJECTED 状态验证不应通过!响应:${NC} %s\n" "$VERIFY_REJ"
  exit 1
fi

# 3) 录入人整改:上传整改版文件 → 整改重提(状态 REJECTED → ANCHORED)
printf '链田守护演示检验报告(HIGH 场景整改版)\n批次:%s\n整改:农残复检合格\n' \
  "$HIGH_BATCH" > "$WORK_DIR/report-high-v2.txt"
UPLOAD_H2=$(api "HIGH 整改版上传 IPFS" -s -F "file=@$WORK_DIR/report-high-v2.txt" "$API/upload?role=operator")
CID_H2=$(json_str cid "$UPLOAD_H2")
SHA_H2=$(json_str sha256 "$UPLOAD_H2")
api "整改重提成功(状态 REJECTED → ANCHORED,新版本追加、旧版本归档)" \
  -s -X POST "$API/batches/$HIGH_BATCH/resubmit?role=operator" \
  -H 'Content-Type: application/json' \
  -d "{\"newCid\":\"$CID_H2\",\"newSha256\":\"$SHA_H2\",\"reason\":\"已复检整改:农残达标\"}" >/dev/null

# 4) 重新 AI 预检(整改后达标数据 → NORMAL,旧 HIGH 结论自动归档 aiChecks)
AI_H2=$(api "重新预检完成(整改后 NORMAL,旧 HIGH 结论归档链上保留)" \
  -s -X POST "$API/batches/$HIGH_BATCH/ai-check?role=operator" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"山东寿光","produceType":"叶菜类","pesticideResidue":0.001,"heavyMetalPb":0.01,"moisturePct":9}')
RISK_LEVEL2=$(json_str riskLevel "$AI_H2")
info "整改后 AI 风险等级: $RISK_LEVEL2"

# 5) 重新核对签名 + 锁定发证(整改后可合格签发)
api "重新核对签名通过(状态 → COUNTER_SIGNED)" \
  -s -X POST "$API/batches/$HIGH_BATCH/countersign?role=checker" >/dev/null
FINAL_H=$(api "锁定发证(状态 → FINALIZED,驳回整改后也能合格签发)" \
  -s -X POST "$API/batches/$HIGH_BATCH/finalize?role=auditor")
CREDENTIAL_H=$(json_str credentialId "$FINAL_H")
info "HIGH 批次凭证 ID: $CREDENTIAL_H"

# 6) 真正放行后消费者验证整改版 MATCH
api "整改版文件哈希核验 MATCH(真正放行后才可对外验证)" \
  -s -X POST "$API/verify/$HIGH_BATCH?role=regulator" \
  -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$SHA_H2\"}" >/dev/null

info "闭环完成:AI 告警 → 人工驳回 → 整改重提 → 重新预检 → 重新签名 → 合格签发,AI 全程只辅助、不替代人工"

# =============================================================================
# 2. 核对人:核对签名(后端签名,链上验签)
# =============================================================================
step 2 "核对人(checker)核对签名"
info "核对人已看到 AI 风险提示(WARN:农药残留超标),人工复核后决定继续签名 —— AI 只辅助、不替代人工"
api "核对签名成功(状态 COUNTER_SIGNED,签名上链)" \
  -s -X POST "$API/batches/$BATCH_ID/countersign?role=checker" >/dev/null

# =============================================================================
# 3. 录入人:上传修订版 → 发起追加式修改
# =============================================================================
step 3 "录入人(operator)发起追加式修改"
printf '链田守护演示检验报告(修订版)\n批次:%s\n修订:补充重金属检测项\n结论:全部合格\n' \
  "$BATCH_ID" > "$WORK_DIR/report-v2.txt"

UPLOAD2=$(api "修订版文件上传 IPFS" -s -F "file=@$WORK_DIR/report-v2.txt" "$API/upload?role=operator")
CID_V2=$(json_str cid "$UPLOAD2")
SHA_V2=$(json_str sha256 "$UPLOAD2")

api "修改请求已提交(状态 PENDING)" \
  -s -X POST "$API/batches/$BATCH_ID/modification-request?role=operator" \
  -H 'Content-Type: application/json' \
  -d "{\"newCid\":\"$CID_V2\",\"newSha256\":\"$SHA_V2\",\"reason\":\"补充重金属检测项\"}" >/dev/null

# =============================================================================
# 4. 审核人:批准修改(v2 追加,v1 归档 DEPRECATED)
# =============================================================================
step 4 "审核人(auditor)复核并批准修改"
api "修改已批准(版本 v2 追加,旧版本 DEPRECATED 保留)" \
  -s -X POST "$API/batches/$BATCH_ID/modification-approve?role=auditor" \
  -H 'Content-Type: application/json' \
  -d '{"approved":true}' >/dev/null

# =============================================================================
# 5. 审核人:锁定发证(生成数字凭证 ID)
# =============================================================================
step 5 "审核人(auditor)锁定并颁发数字凭证"
FINAL=$(api "批次已锁定(状态 FINALIZED)" \
  -s -X POST "$API/batches/$BATCH_ID/finalize?role=auditor")
CREDENTIAL=$(json_str credentialId "$FINAL")
info "数字凭证 ID: $CREDENTIAL"

# =============================================================================
# 6. 消费者:本地哈希与链上比对(MATCH / MISMATCH)
# =============================================================================
step 6 "消费者(regulator 代表查询)验证数据"
api "正确文件哈希核验 MATCH" \
  -s -X POST "$API/verify/$BATCH_ID?role=regulator" \
  -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$SHA_V2\"}" >/dev/null
api "篡改哈希核验 MISMATCH(链上识别出不一致)" \
  -s -X POST "$API/verify/$BATCH_ID?role=regulator" \
  -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$(printf '0%.0s' {1..64})\"}" >/dev/null

# =============================================================================
# 7. 监管方:全版本历史审计(两个版本完整可见)
# =============================================================================
step 7 "监管方(regulator)审计全版本历史"
VERSIONS=$(api "全版本历史查询成功" -s "$API/batches/$BATCH_ID/versions?role=regulator")
V1_STATUS=$(grep -o '"status":"[A-Z]*"' <<<"$VERSIONS" | head -1 | cut -d'"' -f4)
V2_STATUS=$(grep -o '"status":"[A-Z]*"' <<<"$VERSIONS" | tail -1 | cut -d'"' -f4)
info "v1 状态: $V1_STATUS(已归档) · v2 状态: $V2_STATUS(当前生效)"

# =============================================================================
# 总结
# =============================================================================
printf "\n${GREEN}════════════════════════════════════════════════${NC}\n"
printf "${GREEN}  演示流程全部跑通!批次: %s${NC}\n" "$BATCH_ID"
printf "${GREEN}  数字凭证: %s${NC}\n" "$CREDENTIAL"
printf "${GREEN}════════════════════════════════════════════════${NC}\n"
