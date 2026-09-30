// =============================================================================
// 角色全局状态:当前扮演的角色(operator/checker/auditor/regulator)。
//
// 角色说明:后端按角色选择钱包身份提交交易,链码按证书 role 属性校验权限。
// 前端切换角色 = 切换"以谁的身份操作",真正权限由链码保证。
// =============================================================================

import { reactive, watch } from 'vue';

// 本地存储键名(刷新页面后保留上次选择的角色)
const STORAGE_KEY = 'chain-field-guard-role';

// 四个角色的元信息(名称、职责描述、可用操作,用于面板提示)
export const ROLE_META = {
  operator: { label: '录入人', desc: '上传文件并锚定上链,可发起修改请求', org: 'Org1 业务方' },
  checker: { label: '核对人', desc: '核对数据并二级签名,可发起修改请求', org: 'Org1 业务方' },
  auditor: { label: '审核人', desc: '复核修改请求、锁定批次并颁发凭证', org: 'Org1 业务方' },
  regulator: { label: '监管方', desc: '只读:验证数据、审计全版本历史', org: 'Org2 监管方' },
};

export const roleStore = reactive({
  // 初始化:优先取本地存储,否则默认 operator
  role: localStorage.getItem(STORAGE_KEY) || 'operator',
});

// 角色变化时持久化到 localStorage
watch(
  () => roleStore.role,
  (val) => localStorage.setItem(STORAGE_KEY, val)
);

/** 当前角色元信息(供页面顶部提示使用) */
export function currentRoleMeta() {
  return ROLE_META[roleStore.role] ?? ROLE_META.operator;
}
