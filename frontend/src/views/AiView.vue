<!-- ===========================================================================
  AI 预检页(录入人 operator):
    1. 输入批次号查询批次状态;
    2. 批次处于 ANCHORED(锚定之后、核对签名之前)且未预检时,填写结构化
       检测数据(产地/产品类型 + 农残/铅/水分)触发链下 AI 分析;
    3. AI 结论(风险评分/等级/异常项/模型版本)哈希上链存证,页面展示结果;
    4. 已预检的批次只读展示,监管方可核验报告哈希(verified)。

  设计说明:AI 预检是"链下智能 + 链上存证"的辅助环节 —— 结论不改变批次
  状态机,核对人在签名前可查看风险提示,自行决定继续签名或发起修改。
  =========================================================================== -->

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getBatch, aiCheck, getAiCheck, ipfsUrl } from '../api/index.js';

const batchId = ref(''); // 查询批次号
const batch = ref(null); // 批次详情(状态 + aiCheck)
const verified = ref(null); // 监管追溯核验结果(报告哈希是否一致)
const checking = ref(false); // 预检提交中标记

// 结构化检测数据表单(数值字段必填,单位与后端规则引擎一致)
const form = ref({
  origin: '',
  produceType: '',
  pesticideResidue: null,
  heavyMetalPb: null,
  moisturePct: null,
});

/** 查询批次:拿到状态与已有 AI 存证 */
async function doQuery() {
  if (!batchId.value.trim()) {
    ElMessage.warning('请输入批次号');
    return;
  }
  batch.value = null;
  verified.value = null;
  try {
    batch.value = await getBatch(batchId.value.trim());
    // 已预检的批次,额外查询报告哈希核验结果(监管追溯)
    if (batch.value.aiCheck) {
      const res = await getAiCheck(batchId.value.trim());
      verified.value = res.verified;
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
    const updated = await aiCheck(batch.value.batchId, {
      origin: form.value.origin,
      produceType: form.value.produceType,
      pesticideResidue: Number(form.value.pesticideResidue),
      heavyMetalPb: Number(form.value.heavyMetalPb),
      moisturePct: Number(form.value.moisturePct),
    });
    batch.value = updated;
    verified.value = null; // 刚存证,核验标记留到查询接口
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
            <el-tag :type="batch.status === 'ANCHORED' ? 'warning' : 'success'">
              {{ batch.status }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 已预检:只读展示存证结论 -->
        <template v-if="batch.aiCheck">
          <el-divider content-position="left">AI 预检存证(链上)</el-divider>
          <el-descriptions :column="2" border size="small">
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
          <div class="action-row">
            <el-button @click="doQuery">重新核验</el-button>
            <el-link type="primary" :href="ipfsUrl(batch.aiCheck.reportCid)" target="_blank">
              查看完整 AI 分析报告(IPFS)
            </el-link>
          </div>
        </template>

        <!-- ANCHORED 且未预检:结构化数据表单 -->
        <template v-else-if="batch.status === 'ANCHORED'">
          <el-divider content-position="left">录入结构化检测数据,触发链下 AI 分析</el-divider>
          <el-form label-width="120px" class="ai-form">
            <el-form-item label="产地">
              <el-input v-model="form.origin" placeholder="如 山东寿光" style="width: 260px" />
            </el-form-item>
            <el-form-item label="产品类型">
              <el-input v-model="form.produceType" placeholder="如 叶菜类" style="width: 260px" />
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
            <el-form-item>
              <el-button type="primary" :loading="checking" @click="doAiCheck">
                触发 AI 预检并上链存证
              </el-button>
            </el-form-item>
          </el-form>
        </template>

        <!-- 其他状态:提示不支持 -->
        <el-alert
          v-else
          type="info"
          show-icon
          :closable="false"
          title="AI 预检仅支持 ANCHORED 状态(锚定之后、核对签名之前),当前状态不支持。"
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
  max-width: 560px;
}
.field-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.flag-tag {
  margin-right: 8px;
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
</style>
