<!-- ===========================================================================
  消费者验证页(任意角色,面向终端消费者):
    1. 输入批次号 + 选择本地文件(或粘贴 SHA-256);
    2. 前端计算文件 SHA-256,调用 VerifyBatch 与链上当前版本哈希比对;
    3. MATCH:文件与链上锚定数据一致(未被篡改);MISMATCH:不一致,警示。
    说明:哈希在浏览器本地计算,文件内容不会上传。
  =========================================================================== -->

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { verifyBatch } from '../api/index.js';

const batchId = ref(''); // 待验证批次号
const file = ref(null); // 消费者手中的文件
const shaInput = ref(''); // 手动输入的 SHA-256(与文件二选一)
const verifying = ref(false); // 验证中标记
const result = ref(null); // { batchId, sha256, outcome: 'MATCH'|'MISMATCH', at }

/** 文件选择后自动计算 SHA-256 填充到输入框(可手工修改) */
async function handleChange(f) {
  file.value = f.raw ?? f;
  if (file.value) {
    const buf = await file.value.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    shaInput.value = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    ElMessage.info('已计算文件 SHA-256,可点击验证');
  }
}

/** 执行链上哈希比对 */
async function doVerify() {
  if (!batchId.value.trim() || !shaInput.value.trim()) {
    ElMessage.warning('请输入批次号并提供文件或 SHA-256');
    return;
  }
  verifying.value = true;
  result.value = null;
  try {
    const outcome = await verifyBatch(batchId.value.trim(), shaInput.value.trim());
    result.value = {
      batchId: batchId.value.trim(),
      sha256: shaInput.value.trim(),
      outcome,
      at: new Date().toLocaleString('zh-CN'),
    };
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    verifying.value = false;
  }
}
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>消费者验证</b>
        <span class="hint">本地计算哈希与链上比对,文件不离开您的设备</span>
      </template>

      <!-- 输入区 -->
      <el-form label-width="110px">
        <el-form-item label="批次号">
          <el-input v-model="batchId" placeholder="如 B2026-001" style="width: 320px" />
        </el-form-item>
        <el-form-item label="验证文件">
          <el-upload :auto-upload="false" :limit="1" :on-change="handleChange">
            <el-button>选择文件(自动计算 SHA-256)</el-button>
          </el-upload>
        </el-form-item>
        <el-form-item label="SHA-256">
          <el-input
            v-model="shaInput"
            type="textarea"
            :rows="2"
            placeholder="自动填入,或粘贴商品标签上的 SHA-256"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="verifying" @click="doVerify">
            链上核验(VerifyBatch)
          </el-button>
        </el-form-item>
      </el-form>

      <!-- 验证结果 -->
      <el-result
        v-if="result"
        :icon="result.outcome === 'MATCH' ? 'success' : 'error'"
        :title="result.outcome === 'MATCH' ? '核验通过:数据与链上一致' : '核验失败:数据与链上不一致'"
        :sub-title="`批次 ${result.batchId} · 核验时间 ${result.at}`"
      >
        <template #extra>
          <el-tag :type="result.outcome === 'MATCH' ? 'success' : 'danger'" size="large">
            {{ result.outcome }}
          </el-tag>
        </template>
      </el-result>

      <!-- 引导 -->
      <el-empty v-if="!result" description="批次号 + 文件(或哈希)即可完成核验" />
    </el-card>
  </div>
</template>

<style scoped>
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
</style>
