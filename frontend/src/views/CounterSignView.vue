<!-- ===========================================================================
  核对签名页(核对人 checker):
    1. 输入批次号查询批次详情与当前生效版本(CID/SHA-256);
    2. 可点击链接从 IPFS 取回文件核对内容;
    3. 依据 AI 风险提示人工复核:
       - 确认无误 → 点击"核对签名",后端用核对人钱包私钥对数据包签名,
         链码验签后批次状态 ANCHORED → COUNTER_SIGNED(不可抵赖);
       - 认定不合格 → 填写驳回原因点击"核对驳回",链码验签后状态
         ANCHORED → REJECTED(驳回历史链上留痕),录入人整改后可重新提交。
  =========================================================================== -->

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getBatch, counterSign, rejectCounterSign, ipfsUrl } from '../api/index.js';

const batchId = ref(''); // 查询批次号
const batch = ref(null); // 查询到的批次详情
const signing = ref(false); // 签名提交中标记
const rejecting = ref(false); // 驳回提交中标记
const rejectReason = ref(''); // 驳回原因(必填,链上留痕)

/** 状态 → 标签样式:REJECTED 红色、ANCHORED/PENDING 黄色、其余绿色 */
function statusTagType(status) {
  if (status === 'REJECTED') return 'danger';
  if (status === 'ANCHORED' || status === 'PENDING') return 'warning';
  return 'success';
}

/** 查询批次详情(核对人可查询) */
async function doQuery() {
  if (!batchId.value.trim()) {
    ElMessage.warning('请输入批次号');
    return;
  }
  batch.value = null;
  try {
    batch.value = await getBatch(batchId.value.trim());
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/** 核对签名:后端签名 + 链上验签 */
async function doCounterSign() {
  signing.value = true;
  try {
    const updated = await counterSign(batch.value.batchId);
    batch.value = updated;
    ElMessage.success(`核对签名成功,状态:${updated.status},链上已留存签名`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    signing.value = false;
  }
}

/** 核对驳回:附原因 + 后端签名 + 链上验签(ANCHORED → REJECTED) */
async function doReject() {
  if (!rejectReason.value.trim()) {
    ElMessage.warning('请填写驳回原因(如:农残超标,退回整改)');
    return;
  }
  rejecting.value = true;
  try {
    const updated = await rejectCounterSign(batch.value.batchId, rejectReason.value.trim());
    batch.value = updated;
    rejectReason.value = '';
    ElMessage.success(`已驳回核对,状态:${updated.status},驳回原因已链上留痕`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    rejecting.value = false;
  }
}
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>核对签名(核对人)</b>
        <span class="hint">核对数据无误后二级签名,链上验签留痕</span>
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

      <!-- 批次详情与当前版本 -->
      <template v-if="batch">
        <el-descriptions :column="2" border size="small" class="batch-desc">
          <el-descriptions-item label="批次号">{{ batch.batchId }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTagType(batch.status)">
              {{ batch.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="当前版本">v{{ batch.currentVersion }}</el-descriptions-item>
          <el-descriptions-item label="已签名次数">{{ batch.signatures?.length ?? 0 }}</el-descriptions-item>
          <el-descriptions-item label="CID" :span="2">{{ batch.versions[batch.currentVersion - 1].cid }}</el-descriptions-item>
          <el-descriptions-item label="SHA-256" :span="2">
            {{ batch.versions[batch.currentVersion - 1].sha256 }}
          </el-descriptions-item>
        </el-descriptions>

        <!-- AI 预检风险提示(链上存证的辅助证据,仅供人工参考,不改变状态机) -->
        <el-alert
          v-if="batch.aiCheck"
          :type="batch.aiCheck.riskLevel === 'HIGH' ? 'error' : batch.aiCheck.riskLevel === 'WARN' ? 'warning' : 'info'"
          show-icon
          :closable="false"
          class="ai-alert"
        >
          <template #title>
            <b>AI 预检提示(仅供参考,请人工复核后决定是否签名):</b>
            风险评分 {{ batch.aiCheck.riskScore }}/100(等级 {{ batch.aiCheck.riskLevel }}),
            <template v-if="batch.aiCheck.flags && batch.aiCheck.flags.length">
              异常项:{{ batch.aiCheck.flags.join('、') }}。
            </template>
            <template v-else>无异常项。</template>
            <template v-if="batch.aiCheck.riskLevel === 'HIGH'">
              红色告警:存在高风险异常,强烈建议人工复核数据或由录入人发起修改后再签名!
            </template>
            <template v-else>
              可继续签名或由录入人发起修改。
            </template>
            模型版本 {{ batch.aiCheck.modelVersion }}。
          </template>
        </el-alert>

        <!-- 驳回历史(批次曾被核对驳回) -->
        <el-alert
          v-if="batch.rejections && batch.rejections.length"
          type="error"
          show-icon
          :closable="false"
          class="ai-alert"
        >
          <template #title>
            <b>驳回历史(共 {{ batch.rejections.length }} 次,整改重提后保留可查):</b>
          </template>
          <div v-for="(r, i) in batch.rejections" :key="i" class="reject-item">
            第 {{ i + 1 }} 次:{{ r.reason }}({{ r.rejectedBy }} · {{ r.rejectedAt }})
          </div>
        </el-alert>

        <!-- 核对操作区 -->
        <div class="action-row">
          <el-button @click="doQuery">刷新状态</el-button>
          <!-- 从 IPFS 取回文件核对内容(新标签页打开) -->
          <el-link
            type="primary"
            :href="ipfsUrl(batch.versions[batch.currentVersion - 1].cid)"
            target="_blank"
          >
            从 IPFS 取回文件核对
          </el-link>
          <template v-if="batch.status === 'ANCHORED'">
            <el-button
              type="success"
              :loading="signing"
              @click="doCounterSign"
            >
              核对签名(CounterSign)
            </el-button>
            <el-input
              v-model="rejectReason"
              placeholder="驳回原因(如:农残超标,退回整改)"
              class="reject-input"
            />
            <el-button
              type="danger"
              plain
              :loading="rejecting"
              @click="doReject"
            >
              核对驳回(RejectCounterSign)
            </el-button>
          </template>
          <el-tag v-else-if="batch.status === 'COUNTER_SIGNED'" type="success">
            已核对签名,可发起修改或由审核人锁定
          </el-tag>
          <el-tag v-else-if="batch.status === 'REJECTED'" type="danger">
            已驳回,等待录入人整改后重新提交
          </el-tag>
          <el-tag v-else type="info">当前状态 {{ batch.status }} 不支持核对操作</el-tag>
        </div>
      </template>

      <!-- 未查询时给出引导 -->
      <el-empty v-else description="输入批次号查询待核对的数据" />
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
.ai-alert {
  margin-bottom: 16px;
}
.reject-item {
  font-size: 12px;
  line-height: 1.8;
}
.reject-input {
  width: 300px;
}
.action-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
  flex-wrap: wrap;
}
</style>
