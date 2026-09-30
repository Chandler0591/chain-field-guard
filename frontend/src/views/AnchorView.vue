<!-- ===========================================================================
  上传锚定页(录入人 operator):
    1. 选择文件上传 IPFS → 得到 CID 与 SHA-256(链上只存这两个指纹);
    2. 填写批次号,把 CID+哈希锚定上链(INIT → ANCHORED,写入版本 v1)。
  =========================================================================== -->

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { uploadFile, anchorBatch } from '../api/index.js';

// ---- 表单与状态 ----
const file = ref(null); // 选中的文件(Upload 组件 file 对象)
const batchId = ref(''); // 批次号(链上状态键,唯一)
const uploaded = ref(null); // 上传结果 { cid, sha256, size, name }
const anchoring = ref(false); // 锚定提交中标记(防重复点击)
const anchored = ref(null); // 锚定后的链上批次对象(展示用)

/** 上传前校验:文件大小限制 10MB(与后端 multer 限制一致) */
function beforeUpload(f) {
  if (f.size > 10 * 1024 * 1024) {
    ElMessage.error('文件不能超过 10MB');
    return false;
  }
  return true;
}

/** 文件选择变化时重置上一次的上传结果 */
function handleChange(f) {
  file.value = f.raw ?? f;
  uploaded.value = null;
}

/** 步骤 1:上传文件到 IPFS */
async function doUpload() {
  if (!file.value) {
    ElMessage.warning('请先选择文件');
    return;
  }
  try {
    uploaded.value = await uploadFile(file.value);
    ElMessage.success(`上传成功,CID: ${uploaded.value.cid}`);
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/** 步骤 2:锚定上链(写入版本 v1) */
async function doAnchor() {
  if (!uploaded.value) {
    ElMessage.warning('请先上传文件');
    return;
  }
  if (!batchId.value.trim()) {
    ElMessage.warning('请填写批次号');
    return;
  }
  anchoring.value = true;
  try {
    anchored.value = await anchorBatch(
      batchId.value.trim(),
      uploaded.value.cid,
      uploaded.value.sha256
    );
    ElMessage.success(`批次 ${anchored.value.batchId} 锚定成功,状态:${anchored.value.status}`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    anchoring.value = false;
  }
}
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>数据锚定(录入人)</b>
        <span class="hint">文件上传 IPFS,链上只存 CID + SHA-256</span>
      </template>

      <!-- 步骤 1:上传文件 -->
      <el-steps :active="uploaded ? 1 : 0" simple>
        <el-step title="上传文件到 IPFS" />
        <el-step title="锚定上链(写入 v1)" />
      </el-steps>

      <div class="step-block">
        <div class="step-title">① 上传检验文件</div>
        <el-upload
          drag
          :auto-upload="false"
          :limit="1"
          :on-change="handleChange"
          :before-upload="beforeUpload"
        >
          <div class="el-upload__text">将文件拖到此处,或<em>点击选择</em></div>
        </el-upload>
        <el-button type="primary" :disabled="!file" @click="doUpload">上传到 IPFS</el-button>
        <div v-if="uploaded" class="result-box">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="文件名">{{ uploaded.name }}</el-descriptions-item>
            <el-descriptions-item label="CID">{{ uploaded.cid }}</el-descriptions-item>
            <el-descriptions-item label="SHA-256">{{ uploaded.sha256 }}</el-descriptions-item>
            <el-descriptions-item label="大小">{{ uploaded.size }} 字节</el-descriptions-item>
          </el-descriptions>
        </div>
      </div>

      <!-- 步骤 2:锚定上链 -->
      <div class="step-block">
        <div class="step-title">② 锚定上链</div>
        <el-form label-width="80px">
          <el-form-item label="批次号">
            <el-input
              v-model="batchId"
              placeholder="如 B2026-001(链上唯一键)"
              style="width: 320px"
            />
          </el-form-item>
          <el-form-item>
            <el-button
              type="success"
              :disabled="!uploaded"
              :loading="anchoring"
              @click="doAnchor"
            >
              锚定上链(AnchorData)
            </el-button>
          </el-form-item>
        </el-form>

        <!-- 锚定结果 -->
        <el-result
          v-if="anchored"
          icon="success"
          :title="`批次 ${anchored.batchId} 已锚定`"
          :sub-title="`状态 ${anchored.status} · 当前版本 v${anchored.currentVersion}`"
        >
          <template #extra>
            <el-tag type="success">可在「核对签名」页由核对人继续处理</el-tag>
          </template>
        </el-result>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.step-block {
  margin-top: 24px;
}
.step-title {
  font-weight: bold;
  margin-bottom: 12px;
}
.result-box {
  margin-top: 16px;
}
</style>
