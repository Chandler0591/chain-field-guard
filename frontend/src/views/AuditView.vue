<!-- ===========================================================================
  监管审计页(监管方 regulator 等全角色):
    1. 输入批次号查询全版本历史(GetAllVersions,含 DEPRECATED 版本);
    2. 表格展示:版本号、状态(ACTIVE/DEPRECATED)、CID、SHA-256、锚定人/时间;
    3. 体现"追加式修改、历史永不覆盖"的审计能力。
  =========================================================================== -->

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getVersions, getBatch, ipfsUrl } from '../api/index.js';

const batchId = ref(''); // 查询批次号
const batch = ref(null); // 批次概览(状态/当前版本/凭证)
const versions = ref([]); // 全版本历史

// 版本状态标签:ACTIVE 绿色,DEPRECATED 灰色
function versionTagType(status) {
  return status === 'ACTIVE' ? 'success' : 'info';
}

/** 查询全版本历史 */
async function doQuery() {
  if (!batchId.value.trim()) {
    ElMessage.warning('请输入批次号');
    return;
  }
  batch.value = null;
  versions.value = [];
  try {
    batch.value = await getBatch(batchId.value.trim());
    versions.value = await getVersions(batchId.value.trim());
    ElMessage.success(`共查到 ${versions.value.length} 个版本`);
  } catch (err) {
    ElMessage.error(err.message);
  }
}
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>监管审计(全版本历史)</b>
        <span class="hint">修改永远追加、不覆盖,历史版本完整可查</span>
      </template>

      <!-- 批次查询 -->
      <el-form inline>
        <el-form-item label="批次号">
          <el-input v-model="batchId" placeholder="如 B2026-001" style="width: 240px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="doQuery">查询版本历史</el-button>
        </el-form-item>
      </el-form>

      <!-- 批次概览 -->
      <el-descriptions v-if="batch" :column="4" border size="small" class="overview">
        <el-descriptions-item label="批次号">{{ batch.batchId }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ batch.status }}</el-descriptions-item>
        <el-descriptions-item label="当前版本">v{{ batch.currentVersion }}</el-descriptions-item>
        <el-descriptions-item label="凭证">
          <span v-if="batch.credentialId">{{ batch.credentialId }}</span>
          <span v-else>—</span>
        </el-descriptions-item>
      </el-descriptions>

      <!-- 全版本历史表格 -->
      <el-table v-if="versions.length" :data="versions" border size="small" class="table">
        <el-table-column prop="version" label="版本" width="80">
          <template #default="{ row }">
            <b>v{{ row.version }}</b>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="versionTagType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="cid" label="IPFS CID" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <el-link type="primary" :href="ipfsUrl(row.cid)" target="_blank">
              {{ row.cid }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column prop="sha256" label="SHA-256" min-width="200" show-overflow-tooltip />
        <el-table-column prop="anchoredBy" label="锚定人" width="140" />
        <el-table-column prop="anchoredAt" label="锚定时间" width="200" />
      </el-table>

      <el-empty v-if="!versions.length" description="输入批次号查询全版本审计历史" />
    </el-card>
  </div>
</template>

<style scoped>
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.overview {
  margin: 16px 0;
}
.table {
  margin-top: 8px;
}
</style>
