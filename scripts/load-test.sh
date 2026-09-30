#!/usr/bin/env bash
# =============================================================================
# 链田守护 · 简单压测脚本(可选,答辩加分项)
#
# 作用:连续锚定 N 个批次(operator 身份),统计总耗时与平均 TPS,
#      给出"联盟链写吞吐"的演示数据。
#
# 前置条件:与 scripts/demo.sh 相同(网络 + IPFS + 后端就绪)。
# 运行方式:
#   ./scripts/load-test.sh            # 默认 20 个批次
#   ./scripts/load-test.sh 50         # 指定批次数
#
# 说明:每批只做一次 AnchorData 写交易;如需统计核对签名吞吐,
#      可参考 demo.sh 扩展 CounterSign 循环。
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API="$BASE_URL/api"
COUNT="${1:-20}"

echo "=== 链田守护压测:锚定 $COUNT 个批次 ==="
START=$(date +%s)

for i in $(seq 1 "$COUNT"); do
  BATCH_ID="LOAD-$(date +%s)-$i"
  # 每个批次上传一份 1KB 随机内容文件(链上只存哈希,数据量不影响链码逻辑)
  head -c 1024 /dev/urandom > /tmp/load-file.bin
  UPLOAD=$(curl -s -F "file=@/tmp/load-file.bin" "$API/upload?role=operator")
  CID=$(grep -o '"cid":"[^"]*"' <<<"$UPLOAD" | head -1 | cut -d'"' -f4)
  SHA=$(grep -o '"sha256":"[^"]*"' <<<"$UPLOAD" | head -1 | cut -d'"' -f4)

  RESP=$(curl -s -X POST "$API/batches?role=operator" \
    -H 'Content-Type: application/json' \
    -d "{\"batchId\":\"$BATCH_ID\",\"dataCid\":\"$CID\",\"sha256\":\"$SHA\"}")
  if ! grep -q '"ok":true' <<<"$RESP"; then
    echo "批次 $i 失败: $RESP"
    exit 1
  fi
  printf "\r已锚定 %s/%s" "$i" "$COUNT"
done

END=$(date +%s)
ELAPSED=$((END - START))
rm -f /tmp/load-file.bin

echo ""
echo "=== 压测完成 ==="
echo "批次数: $COUNT"
echo "总耗时: ${ELAPSED}s"
# 平均每秒锚定批次(含 IPFS 上传时间,实际链上写吞吐会更高)
AVG=$(awk "BEGIN{printf \"%.2f\", $COUNT/$ELAPSED}")
echo "平均吞吐: ${AVG} 批次/秒(含文件上传;可再单独测纯链上写)"
