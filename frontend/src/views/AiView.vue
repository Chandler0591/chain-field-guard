<!-- ===========================================================================
  AI 预检页(录入人 operator):
    1. 输入批次号查询批次状态;
    2. 批次处于 ANCHORED(锚定之后、核对签名之前)时,填写结构化检测数据
       (产地/产品类型 + 农残/铅/水分)触发链下 AI 分析;
    3. AI 结论(风险评分/等级/异常项/模型版本)哈希上链存证,页面展示结果;
    4. 整改重提后(REJECTED → ANCHORED)允许重新预检:旧结论自动归档到
       aiChecks 历史列表,新结论覆盖 aiCheck,历史永不丢失;
    5. 监管方可核验报告哈希(verified)。

  设计说明:AI 预检是"链下智能 + 链上存证"的辅助环节 —— 结论不改变批次
  状态机,核对人在签名前可查看风险提示,自行决定继续签名、驳回或发起修改。
  =========================================================================== -->

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getBatch, aiCheck, getAiCheck, ipfsUrl } from '../api/index.js';
import { roleStore } from '../store/role.js';

const batchId = ref(''); // 查询批次号
const batch = ref(null); // 批次详情(状态 + aiCheck)
const verified = ref(null); // 监管追溯核验结果(报告哈希是否一致)
const checking = ref(false); // 预检提交中标记
const detail = ref([]); // 各维度得分明细(指标/检测值/得分/档位,不入链)

// 结构化检测数据表单(数值字段必填,单位与后端规则引擎一致;
// 菌落总数/亚硝酸盐为可选维度,填了才参与风险评分)
const form = ref({
  origin: '',
  produceType: '',
  pesticideResidue: null,
  heavyMetalPb: null,
  moisturePct: null,
  totalBacteria: null,
  nitrite: null,
});

/** 查询批次:拿到状态与已有 AI 存证 */
async function doQuery() {
  if (!batchId.value.trim()) {
    ElMessage.warning('请输入批次号');
    return;
  }
  batch.value = null;
  verified.value = null;
  detail.value = [];
  try {
    batch.value = await getBatch(batchId.value.trim());
    // 已预检的批次,额外查询报告哈希核验结果与得分明细(监管追溯)
    if (batch.value.aiCheck) {
      const res = await getAiCheck(batchId.value.trim());
      verified.value = res.verified;
      detail.value = res.detail ?? [];
    }
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/** 触发 AI 预检:链下分析 → 报告入 IPFS → 结论哈希上链 */
async function doAiCheck() {
  // 前端兜底校验(后端还会再校验一次)
  for (const f of ['pesticideResidue', 'heavyMetalPb', 'moisturePct']) {
    const v = form.value[f];
    if (v === null || v === '' || Number.isNaN(Number(v)) || Number(v) < 0) {
      ElMessage.warning(`请填写有效的非负数值:${f}`);
      return;
    }
  }
  checking.value = true;
  try {
    // 组装提交数据:必填三字段 + 可选维度(填了才传)
    const payload = {
      origin: form.value.origin,
      produceType: form.value.produceType,
      pesticideResidue: Number(form.value.pesticideResidue),
      heavyMetalPb: Number(form.value.heavyMetalPb),
      moisturePct: Number(form.value.moisturePct),
    };
    if (form.value.totalBacteria !== null && form.value.totalBacteria !== '') {
      payload.totalBacteria = Number(form.value.totalBacteria);
    }
    if (form.value.nitrite !== null && form.value.nitrite !== '') {
      payload.nitrite = Number(form.value.nitrite);
    }
    const updated = await aiCheck(batch.value.batchId, payload);
    batch.value = updated;
    verified.value = null; // 刚存证,核验标记留到查询接口
    detail.value = updated.aiDetail ?? []; // 响应附带的得分明细,直接展示
    ElMessage.success('AI 预检完成,结论已哈希上链存证(状态机不变)');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    checking.value = false;
  }
}

/** 风险等级 → 标签样式 */
function levelTagType(level) {
  if (level === 'HIGH') return 'danger';
  if (level === 'WARN') return 'warning';
  return 'success';
}

/** 批次状态 → 标签样式:REJECTED 红色、ANCHORED/PENDING 黄色、其余绿色 */
function statusTagType(status) {
  if (status === 'REJECTED') return 'danger';
  if (status === 'ANCHORED' || status === 'PENDING') return 'warning';
  return 'success';
}
</script>

<template>
  <div class="page-card">
    <el-card shadow="never">
      <template #header>
        <b>AI 预检(录入人)</b>
        <span class="hint">链下智能分析 + 结论哈希上链存证,辅助核对人决策</span>
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
            <el-tag :type="statusTagType(batch.status)">
              {{ batch.status }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 已预检:只读展示存证结论 -->
        <template v-if="batch.aiCheck">
          <el-divider content-position="left">AI 预检存证(链上)</el-divider>
          <el-descriptions :column="2" border size="small" class="ai-desc">
            <el-descriptions-item label="风险评分">
              {{ batch.aiCheck.riskScore }} / 100
            </el-descriptions-item>
            <el-descriptions-item label="风险等级">
              <el-tag :type="levelTagType(batch.aiCheck.riskLevel)" size="large">
                {{ batch.aiCheck.riskLevel }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="异常项" :span="2">
              <el-tag
                v-for="f in batch.aiCheck.flags"
                :key="f"
                type="danger"
                effect="plain"
                class="flag-tag"
              >
                {{ f }}
              </el-tag>
              <span v-if="!batch.aiCheck.flags.length" class="no-flag">无异常</span>
            </el-descriptions-item>
            <el-descriptions-item label="模型版本">{{ batch.aiCheck.modelVersion }}</el-descriptions-item>
            <el-descriptions-item label="报告哈希核验">
              <el-tag v-if="verified === true" type="success">已核验一致</el-tag>
              <el-tag v-else-if="verified === false" type="danger">报告哈希不一致!</el-tag>
              <el-tag v-else type="info">点击查询核验</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="报告 CID" :span="2">
              {{ batch.aiCheck.reportCid }}
            </el-descriptions-item>
            <el-descriptions-item label="报告哈希" :span="2">
              {{ batch.aiCheck.reportHash }}
            </el-descriptions-item>
            <el-descriptions-item label="预检时间" :span="2">
              {{ batch.aiCheck.checkedAt }}(由 {{ batch.aiCheck.checkedBy }} 触发)
            </el-descriptions-item>
          </el-descriptions>

          <!-- 各维度得分明细(不入链,从 IPFS 报告解析;命中维度的判定依据) -->
          <el-table
            v-if="detail.length"
            :data="detail"
            size="small"
            border
            class="detail-table"
            empty-text="无异常维度"
          >
            <el-table-column prop="metric" label="指标" width="120" />
            <el-table-column label="检测值" width="160">
              <template #default="{ row }">{{ row.value }} {{ row.unit }}</template>
            </el-table-column>
            <el-table-column prop="score" label="贡献得分" width="100" />
            <el-table-column prop="level" label="判定档位" />
          </el-table>

          <div class="action-row">
            <el-button @click="doQuery">重新核验</el-button>
            <el-link
              type="primary"
              :href="ipfsUrl(batch.aiCheck.reportCid, `ai-report-${batch.batchId}.json`)"
              target="_blank"
            >
              查看完整 AI 分析报告(IPFS)
            </el-link>
          </div>
        </template>

        <!-- 历史预检归档:整改重提后重新预检时,旧结论归档于 aiChecks(链上保留,不覆盖) -->
        <template v-if="batch.aiChecks && batch.aiChecks.length">
          <el-divider content-position="left">历史预检归档(旧结论链上保留,不覆盖)</el-divider>
          <el-table :data="batch.aiChecks" size="small" border class="history-table">
            <el-table-column prop="checkedAt" label="预检时间" width="170" />
            <el-table-column label="风险评分" width="90">
              <template #default="{ row }">{{ row.riskScore }} / 100</template>
            </el-table-column>
            <el-table-column label="风险等级" width="100">
              <template #default="{ row }">
                <el-tag :type="levelTagType(row.riskLevel)" size="small">{{ row.riskLevel }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="异常项">
              <template #default="{ row }">
                <span v-if="!row.flags || !row.flags.length" class="no-flag">无异常</span>
                <template v-else>
                  <el-tag v-for="f in row.flags" :key="f" type="danger" effect="plain" size="small" class="flag-tag">
                    {{ f }}
                  </el-tag>
                </template>
              </template>
            </el-table-column>
            <el-table-column prop="modelVersion" label="模型版本" width="150" />
          </el-table>
        </template>

        <!-- ANCHORED:结构化数据表单(仅录入人可触发;监管方只读查询/核验/看历史) -->
        <template v-if="batch.status === 'ANCHORED' && roleStore.role === 'operator'">
          <el-divider content-position="left">录入结构化检测数据,触发链下 AI 分析</el-divider>
          <el-alert
            v-if="batch.aiCheck"
            type="warning"
            show-icon
            :closable="false"
            class="recheck-tip"
            title="该批次已有 AI 预检结论。整改重提后可重新预检,旧结论将归档到历史列表(链上保留,不覆盖)。"
          />
          <el-form label-width="200px" class="ai-form">
            <el-form-item label="产地">
              <el-input v-model="form.origin" placeholder="如 山东寿光" style="width: 280px" />
            </el-form-item>
            <el-form-item label="产品类型">
              <el-input v-model="form.produceType" placeholder="如 叶菜类" style="width: 280px" />
            </el-form-item>
            <el-form-item label="农药残留(mg/kg)">
              <el-input-number v-model="form.pesticideResidue" :min="0" :step="0.01" :precision="4" />
              <span class="field-hint">警示阈值 0.01,严重阈值 0.1</span>
            </el-form-item>
            <el-form-item label="重金属铅(mg/kg)">
              <el-input-number v-model="form.heavyMetalPb" :min="0" :step="0.01" :precision="4" />
              <span class="field-hint">警示阈值 0.1,严重阈值 0.2</span>
            </el-form-item>
            <el-form-item label="水分含量(%)">
              <el-input-number v-model="form.moisturePct" :min="0" :step="0.5" :precision="2" />
              <span class="field-hint">合理区间 5% ~ 20%</span>
            </el-form-item>
            <el-form-item label="菌落总数(CFU/g,可选)">
              <el-input-number v-model="form.totalBacteria" :min="0" :step="100000" :precision="0" />
              <span class="field-hint">警示阈值 1000000,严重阈值 10000000</span>
            </el-form-item>
            <el-form-item label="亚硝酸盐(mg/kg,可选)">
              <el-input-number v-model="form.nitrite" :min="0" :step="0.5" :precision="2" />
              <span class="field-hint">警示阈值 2,严重阈值 20</span>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="checking" @click="doAiCheck">
                触发 AI 预检并上链存证
              </el-button>
            </el-form-item>
          </el-form>
        </template>

        <!-- 其他状态且未预检:提示不支持;监管方不可触发时也给出说明 -->
        <el-alert
          v-else-if="!batch.aiCheck"
          type="info"
          show-icon
          :closable="false"
          :title="
            roleStore.role === 'operator'
              ? 'AI 预检仅支持 ANCHORED 状态(锚定之后、核对签名之前),当前状态不支持。'
              : '当前角色为监管方,只读查看 AI 预检存证与历史归档,不触发预检。'
          "
        />
      </template>

      <!-- 未查询时给出引导 -->
      <el-empty v-else description="输入批次号查询,锚定后可在此触发 AI 预检" />
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
.ai-form {
  max-width: 880px;
}
/* 存证展示:label 不换行保持完整宽度(长文本换行已由全局样式处理) */
.ai-desc :deep(.el-descriptions__label) {
  white-space: nowrap;
  min-width: 104px;
}
.field-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.flag-tag {
  margin-right: 8px;
}
.detail-table {
  margin: 12px 0;
  width: 100%;
}
.no-flag {
  color: #67c23a;
  font-size: 13px;
}
.action-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
}
.history-table {
  margin: 12px 0;
  width: 100%;
}
.recheck-tip {
  margin-bottom: 12px;
}
</style>
