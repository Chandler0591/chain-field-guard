// =============================================================================
// 前端入口:创建 Vue 应用并挂载 Element Plus。
// =============================================================================

import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import App from './App.vue';

const app = createApp(App);
// 中文语言包(日期选择器等组件显示中文)
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');
