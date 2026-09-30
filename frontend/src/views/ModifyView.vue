<!-- ===========================================================================
  修改复核页(operator/checker 发起,auditor 复核):
    左半:发起追加式修改 —— 上传新版本文件 → 填写原因 → RequestModification,
          批次状态 COUNTER_SIGNED → PENDING(历史版本不被覆盖);
    右半:审核复核 —— 展示待审核请求,批准(ApproveModification=true)则新版本
          追加为 currentVersion+1、旧版本标 DEPRECATED;拒绝则请求作废。
  =========================================================================== -->

<script setup>
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { roleStore } from '../store/role.js';
import {
  getBatch,
  uploadFile,
  requestModification,
  approveModification,
} from '../api/index.js';

const batchId = ref(''); // 查询批次号
const batch = ref(null); // 批次详情(含 pendingModification 待审核请求)
const reason = ref(''); // 修改原因
const newFile = ref(null); // 新版本文件
const newUploaded = ref(null); // 新文件上传结果 { cid, sha256 }
const submitting = ref(false); // 提交中标记
const reviewing = ref(false); // 复核中标记

// 是否处于可发起修改的状态(COUNTER_SIGNED 且无待审核请求)
const canRequest = computed(
  () =>
    batch.value?.status === 'COUNTER_SIGNED' && !batch.value?.pendingModification
);

// 是否展示待审核请求(审核人复核区)
const showPending = computed(() => !!batch.value?.pendingModification);

/** 查询批次详情 */
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

/** 文件选择变化 */
function handleChange(f) {
  newFile.value = f.raw ?? f;
  newUploaded.value = null;
}

/** 上传新版本文件到 IPFS */
async function doUploadNew() {
  if (!newFile.value) {
    ElMessage.warning('请先选择新版本文件');
    return;
  }
  try {
    newUploaded.value = await uploadFile(newFile.value);
    ElMessage.success(`新版本文件上传成功,CID: ${newUploaded.value.cid}`);
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/** 发起追加式修改请求(operator/checker) */
async function doRequest() {
  if (!newUploaded.value) {
    ElMessage.warning('请先上传新版本文件');
    return;
  }
  submitting.value = true;
  try {
    batch.value = await requestModification(
      batch.value.batchId,
      newUploaded.value.cid,
      newUploaded.value.sha256,
      reason.value.trim() || '未填写原因'
    );
    reason.value = '';
    newUploaded.value = null;
    newFile.value = null;
    ElMessage.success(`修改请求已提交,状态:${batch.value.status},等待审核人复核`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    submitting.value = false;
  }
}

/** 审核复核:批准或拒绝(auditor) */
async function doApprove(approved) {
  reviewing.value = true;
  try {
    batch.value = await approveModification(batch.value.batchId, approved);
    ElMessage.success(
      approved
        ? `已批准修改,当前版本 v${batch.value.currentVersion},历史版本已归档`
        : '已拒绝修改,请求作废'
    );
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    reviewing.value = false;
  }
}
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>修改复核</b>
        <span class="hint">追加式修改:新版本追加,旧版本标记 DEPRECATED 保留可查</span>
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

      <el-row v-if="batch" :gutter="16">
        <!-- 左:发起修改(operator/checker) -->
        <el-col :span="12">
          <div class="panel-title">发起修改(录入人/核对人)</div>
          <template v-if="canRequest">
            <el-upload
              drag
              :auto-upload="false"
              :limit="1"
              :on-change="handleChange"
            >
              <div class="el-upload__text">选择<em>新版本</em>文件</div>
            </el-upload>
            <el-button type="primary" :disabled="!newFile" @click="doUploadNew">
              上传新版本到 IPFS
            </el-button>
            <div v-if="newUploaded" class="new-result">
              <div>CID:{{ newUploaded.cid }}</div>
              <div>SHA-256:{{ newUploaded.sha256 }}</div>
            </div>
            <el-input
              v-model="reason"
              type="textarea"
              :rows="2"
              placeholder="修改原因(如:检验报告内容更正)"
              class="reason-input"
            />
            <el-button
              type="warning"
              :disabled="!newUploaded"
              :loading="submitting"
              @click="doRequest"
            >
              提交修改请求(RequestModification)
            </el-button>
          </template>
          <el-alert
            v-else-if="showPending"
            type="info"
            :closable="false"
            title="当前存在待审核的修改请求,请等待审核人处理"
          />
          <el-alert
            v-else
            type="info"
            :closable="false"
            :title="`状态 ${batch.status} 不支持发起修改(需 COUNTER_SIGNED)`"
          />
        </el-col>

        <!-- 右:审核复核(auditor) -->
        <el-col :span="12">
          <div class="panel-title">审核复核(审核人)</div>
          <template v-if="showPending">
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="新 CID">{{ batch.pendingModification.newCid }}</el-descriptions-item>
              <el-descriptions-item label="新 SHA-256">
                {{ batch.pendingModification.newSha256 }}
              </el-descriptions-item>
              <el-descriptions-item label="修改原因">{{ batch.pendingModification.reason }}</el-descriptions-item>
              <el-descriptions-item label="发起人">{{ batch.pendingModification.requestedBy }}</el-descriptions-item>
            </el-descriptions>
            <div class="review-actions">
              <el-button
                type="success"
                :loading="reviewing"
                :disabled="roleStore.role !== 'auditor'"
                @click="doApprove(true)"
              >
                批准(追加新版本)
              </el-button>
              <el-button
                type="danger"
                :loading="reviewing"
                :disabled="roleStore.role !== 'auditor'"
                @click="doApprove(false)"
              >
                拒绝(请求作废)
              </el-button>
            </div>
            <div v-if="roleStore.role !== 'auditor'" class="role-tip">
              当前角色无复核权限,请切换到「审核人」
            </div>
          </template>
          <el-empty v-else description="暂无待审核的修改请求" :image-size="72" />
        </el-col>
      </el-row>

      <!-- 批次状态概览 -->
      <el-descriptions v-if="batch" :column="3" border size="small" class="status-bar">
        <el-descriptions-item label="状态">
          <el-tag :type="batch.status === 'PENDING' ? 'warning' : 'success'">
            {{ batch.status }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="当前版本">v{{ batch.currentVersion }}</el-descriptions-item>
        <el-descriptions-item label="版本总数">{{ batch.versions?.length ?? 0 }}</el-descriptions-item>
      </el-descriptions>

      <el-empty v-if="!batch" description="输入批次号查询,进行修改或复核" />
    </el-card>
  </div>
</template>

<style scoped>
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.panel-title {
  font-weight: bold;
  margin: 12px 0;
}
.new-result {
  margin: 8px 0;
  font-size: 12px;
  color: #606266;
  word-break: break-all;
}
.reason-input {
  margin: 8px 0;
}
.review-actions {
  margin-top: 12px;
  display: flex;
  gap: 12px;
}
.role-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #e6a23c;
}
.status-bar {
  margin-top: 16px;
}
</style>
