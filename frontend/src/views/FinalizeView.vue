<!-- ===========================================================================
  锁定与凭证页(审核人 auditor):
    1. 查询批次,状态为 COUNTER_SIGNED(无待审核修改)时可锁定;
    2. FinalizeBatch 锁定批次 → FINALIZED,链码生成唯一凭证 ID
       "VC-<batchId>-<txId>"(txId 为锁定交易 ID,链上可回溯);
    3. 锁定后拒绝一切写入;凭证 ID 以二维码展示,便于消费者扫码核验。
  =========================================================================== -->

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import QRCode from 'qrcode';
import { getBatch, finalizeBatch, getCredential } from '../api/index.js';

const batchId = ref(''); // 查询批次号
const batch = ref(null); // 批次详情
const credentialId = ref(''); // 数字凭证 ID(仅 FINALIZED)
const qrDataUrl = ref(''); // 凭证二维码(dataURL,<img> 直接展示)
const finalizing = ref(false); // 锁定提交中标记

/** 查询批次详情 */
async function doQuery() {
  if (!batchId.value.trim()) {
    ElMessage.warning('请输入批次号');
    return;
  }
  batch.value = null;
  credentialId.value = '';
  qrDataUrl.value = '';
  try {
    batch.value = await getBatch(batchId.value.trim());
    // 若已锁定,直接加载凭证与二维码
    if (batch.value.status === 'FINALIZED') {
      await loadCredential();
    }
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/** 加载凭证 ID 并生成二维码 */
async function loadCredential() {
  credentialId.value = await getCredential(batch.value.batchId);
  qrDataUrl.value = await QRCode.toDataURL(credentialId.value, {
    width: 220,
    margin: 1,
    color: { dark: '#1f6f4a' },
  });
}

/** 锁定发证:链码生成凭证 ID,此后拒绝一切写入 */
async function doFinalize() {
  finalizing.value = true;
  try {
    batch.value = await finalizeBatch(batch.value.batchId);
    ElMessage.success(`批次已锁定,凭证已颁发:${batch.value.credentialId}`);
    await loadCredential();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    finalizing.value = false;
  }
}

// 挂载时若 URL 带了 ?batchId=xx 则自动查询(便于从审计页跳转)
onMounted(() => {
  const q = new URLSearchParams(window.location.search).get('batchId');
  if (q) {
    batchId.value = q;
    doQuery();
  }
});
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>锁定与凭证(审核人)</b>
        <span class="hint">锁定后拒绝一切写入,凭证 ID 全局唯一且链上可回溯</span>
      </template>

      <!-- 批次查询 -->
      <el-form inline>
        <el-form-item label="批次号">
          <el-input v-model="batchId" placeholder="如 B2026-001" style="width: 240px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="doQuery">查询批次</el-button>
        </el-form-item>
      </el-form>

      <template v-if="batch">
        <el-descriptions :column="2" border size="small" class="batch-desc">
          <el-descriptions-item label="批次号">{{ batch.batchId }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="batch.status === 'FINALIZED' ? 'success' : batch.status === 'REJECTED' ? 'danger' : 'warning'">
              {{ batch.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="当前版本">v{{ batch.currentVersion }}</el-descriptions-item>
          <el-descriptions-item label="签名数">{{ batch.signatures?.length ?? 0 }}</el-descriptions-item>
          <el-descriptions-item label="凭证 ID" :span="2">
            <span v-if="credentialId" class="credential">{{ credentialId }}</span>
            <span v-else>—(锁定后生成)</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 操作区 -->
        <div class="action-row">
          <el-button
            v-if="batch.status === 'COUNTER_SIGNED'"
            type="success"
            :loading="finalizing"
            @click="doFinalize"
          >
            锁定并颁发凭证(FinalizeBatch)
          </el-button>
          <el-tag v-else-if="batch.status === 'FINALIZED'" type="success">
            已锁定,凭证已颁发,拒绝一切写入
          </el-tag>
          <el-tag v-else-if="batch.status === 'REJECTED'" type="danger">
            批次已被核对驳回,待录入人整改重提后才能重新走核对流程
          </el-tag>
          <el-tag v-else type="info">
            状态 {{ batch.status }} 不可锁定(需 COUNTER_SIGNED 且无待审核修改)
          </el-tag>
        </div>

        <!-- 凭证二维码(消费者扫码核验) -->
        <div v-if="qrDataUrl" class="qr-block">
          <img :src="qrDataUrl" alt="凭证二维码" class="qr-img" />
          <div class="qr-tip">消费者可扫码或输入凭证 ID 在「消费者验证」页核验</div>
        </div>
      </template>

      <el-empty v-if="!batch" description="输入批次号查询并锁定发证" />
    </el-card>
  </div>
</template>

<style scoped>
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.batch-desc {
  margin: 16px 0;
}
.credential {
  font-family: monospace;
  color: #1f6f4a;
  font-weight: bold;
  word-break: break-all;
}
.action-row {
  margin-top: 16px;
}
.qr-block {
  margin-top: 24px;
  text-align: center;
}
.qr-img {
  width: 220px;
  height: 220px;
}
.qr-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}
</style>
