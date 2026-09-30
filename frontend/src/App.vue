<!-- ===========================================================================
  应用外壳:左侧角色切换面板 + 业务导航,右侧渲染当前页面。

  布局说明:
    - 顶部:项目名 + 当前角色标识(标签色区分组织);
    - 左侧:角色切换面板(单选,即"以谁的身份操作")+ 业务菜单;
    - 右侧:当前菜单对应的业务页面(各页面再按角色/状态判断可用性)。
  =========================================================================== -->

<script setup>
import { ref, computed } from 'vue';
import { roleStore, ROLE_META, currentRoleMeta } from './store/role.js';
import AnchorView from './views/AnchorView.vue';
import AiView from './views/AiView.vue';
import CounterSignView from './views/CounterSignView.vue';
import ModifyView from './views/ModifyView.vue';
import FinalizeView from './views/FinalizeView.vue';
import VerifyView from './views/VerifyView.vue';
import AuditView from './views/AuditView.vue';

// 当前选中的业务页面
const activeView = ref('anchor');

// 业务菜单(与状态机环节一一对应)
const MENUS = [
  { key: 'anchor', label: '上传锚定', component: AnchorView, roles: ['operator'] },
  { key: 'ai', label: 'AI 预检', component: AiView, roles: ['operator'] },
  { key: 'countersign', label: '核对签名', component: CounterSignView, roles: ['checker'] },
  { key: 'modify', label: '修改复核', component: ModifyView, roles: ['operator', 'checker', 'auditor'] },
  { key: 'finalize', label: '锁定与凭证', component: FinalizeView, roles: ['auditor'] },
  { key: 'verify', label: '消费者验证', component: VerifyView, roles: ['operator', 'checker', 'auditor', 'regulator'] },
  { key: 'audit', label: '监管审计', component: AuditView, roles: ['operator', 'checker', 'auditor', 'regulator'] },
];

// 当前菜单对应的组件(动态渲染)
const activeComponent = computed(
  () => MENUS.find((m) => m.key === activeView.value)?.component ?? AnchorView
);

// 当前菜单是否允许当前角色操作(不允许时页面给出角色提示)
const currentMenu = computed(() => MENUS.find((m) => m.key === activeView.value));
const roleAllowed = computed(() => currentMenu.value?.roles.includes(roleStore.role) ?? true);

// 角色标签颜色:业务方(Org1)蓝色系,监管方(Org2)橙色系
const roleTagType = computed(() => (roleStore.role === 'regulator' ? 'warning' : 'primary'));
</script>

<template>
  <el-container class="app-shell">
    <!-- 顶部:项目名 + 当前角色 -->
    <el-header class="app-header">
      <div class="app-title">🌾 链田守护 · ChainField Guard</div>
      <div class="app-role">
        <span class="role-hint">当前身份:</span>
        <el-tag :type="roleTagType" size="large">
          {{ currentRoleMeta().label }}({{ currentRoleMeta().org }})
        </el-tag>
      </div>
    </el-header>

    <el-container>
      <!-- 左侧:角色切换面板 + 业务菜单 -->
      <el-aside width="240px" class="app-aside">
        <!-- 角色切换面板 -->
        <div class="role-panel">
          <div class="panel-title">角色切换</div>
          <el-radio-group v-model="roleStore.role" class="role-radios">
            <el-radio v-for="(meta, key) in ROLE_META" :key="key" :value="key" border>
              {{ meta.label }}
            </el-radio>
          </el-radio-group>
          <div class="role-desc">{{ currentRoleMeta().desc }}</div>
        </div>

        <!-- 业务导航 -->
        <el-menu :default-active="activeView" @select="(key) => (activeView = key)">
          <el-menu-item v-for="menu in MENUS" :key="menu.key" :index="menu.key">
            {{ menu.label }}
          </el-menu-item>
        </el-menu>
      </el-aside>

      <!-- 右侧:当前业务页面 -->
      <el-main class="app-main">
        <!-- 当前角色无权使用本页时给出醒目提示 -->
        <el-alert
          v-if="!roleAllowed"
          type="warning"
          show-icon
          :closable="false"
          class="role-alert"
          :title="`当前角色「${currentRoleMeta().label}」无权执行「${currentMenu.label}」,允许角色:${currentMenu.roles.map((r) => ROLE_META[r].label).join('、')},请在左侧切换角色。`"
        />
        <component :is="activeComponent" />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.app-shell {
  height: 100vh;
}
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1f6f4a;
  color: #fff;
}
.app-title {
  font-size: 20px;
  font-weight: bold;
}
.role-hint {
  margin-right: 8px;
  font-size: 13px;
  opacity: 0.9;
}
.app-aside {
  border-right: 1px solid #e4e7ed;
  padding-top: 16px;
}
.role-panel {
  padding: 0 16px 16px;
  border-bottom: 1px solid #e4e7ed;
}
.panel-title {
  font-size: 14px;
  font-weight: bold;
  color: #606266;
  margin-bottom: 12px;
}
.role-radios {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.role-radios :deep(.el-radio) {
  margin-right: 0;
  width: 100%;
}
.role-desc {
  margin-top: 12px;
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.app-main {
  background: #f5f7fa;
  padding: 20px;
}
.role-alert {
  margin-bottom: 16px;
}
</style>

<style>
/* 全局:页面容器统一样式 */
body {
  margin: 0;
  font-family: 'Helvetica Neue', Helvetica, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.page-card {
  max-width: 960px;
  margin: 0 auto;
}
</style>
