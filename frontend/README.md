# frontend/ —— 链田守护前端(Vue 3 + Vite + Element Plus)

> 提供角色切换面板与 7 个业务页面,通过后端 API 与联盟链交互。
> 代码注释详尽,配合 backend/ 一起使用(开发环境由 Vite 代理 /api 到后端 3000 端口)。

## 1. 目录结构

```
frontend/
├── package.json          # 依赖与脚本(Vue3/Vite/ElementPlus/axios/qrcode)
├── vite.config.js        # 开发代理:/api → http://127.0.0.1:3000
├── index.html            # 入口 HTML
└── src/
    ├── main.js           # 应用入口(挂载 Element Plus,中文语言包)
    ├── App.vue           # 外壳:角色切换面板 + 业务菜单 + 页面路由
    ├── store/role.js     # 角色全局状态(operator/checker/auditor/regulator)
    ├── api/index.js      # 后端 API 封装(自动携带 ?role=xx,统一拆包)
    └── views/
        ├── AnchorView.vue       # 上传锚定页(operator)
        ├── AiView.vue           # AI 预检页(operator 触发链下分析,结论哈希上链,含新检测维度与得分明细)
        ├── CounterSignView.vue  # 核对签名页(checker,含 IPFS 预览链接 + AI 风险提示)
        ├── ModifyView.vue       # 修改复核页(operator/checker 发起,auditor 复核)
        ├── FinalizeView.vue     # 锁定与凭证页(auditor,凭证二维码)
        ├── VerifyView.vue       # 消费者验证页(本地算哈希,链上比对)
        └── AuditView.vue        # 监管审计页(全版本历史表格)
```

## 2. 启动步骤

```bash
# 前置:后端已启动(见 backend/README.md),即 backend 目录下 npm start 后
# curl http://127.0.0.1:3000/api/health 返回 healthy

cd frontend
npm install
npm run dev
# 浏览器打开 http://localhost:5173
```

> 后端地址非默认 3000 时:`BACKEND_URL=http://127.0.0.1:<端口> npm run dev`。

## 3. 页面与角色

| 页面 | 允许角色 | 对应链码函数 | 说明 |
| :--- | :--- | :--- | :--- |
| 上传锚定 | 录入人 operator | AnchorData | 上传 IPFS → 锚定上链(v1) |
| AI 预检 | 录入人 operator | RecordAICheck | 录入结构化检测数据(农残/铅/水分/菌落总数/亚硝酸盐)→ 链下 AI 分析 → 结论哈希上链 + 各维度得分明细表(不改状态机) |
| 核对签名 | 核对人 checker | CounterSign | 预览文件 + 查看 AI 风险提示 → 后端签名 → 链上验签 |
| 修改复核 | 录入人/核对人发起,审核人复核 | RequestModification / ApproveModification | 追加式修改,旧版本 DEPRECATED |
| 锁定与凭证 | 审核人 auditor | FinalizeBatch | 锁定发证,凭证 ID + 二维码 |
| 消费者验证 | 全部角色 | VerifyBatch | 本地算 SHA-256,与链上比对 MATCH/MISMATCH |
| 监管审计 | 全部角色 | GetAllVersions | 全版本历史表格 |

- 左侧**角色切换面板**即"以谁的身份操作",切换后所有请求自动携带新角色;
- 角色与页面不匹配时页面顶部出现黄色提示,操作按钮也会禁用/隐藏;
- 真正的权限校验在链码内(证书 role 属性 + Org2 只读),前端限制只是体验优化。

## 4. 演示流程(答辩/验收建议路径)

1. **录入人**:上传锚定页上传检验文件、填批次号锚定(状态 ANCHORED)
2. **录入人**:AI 预检页录入结构化检测数据(产地/农残/铅/水分,可选填菌落总数/亚硝酸盐)→ 链下分析 → 风险结论哈希上链 + 各维度得分明细表(如农残 0.03 → WARN「农药残留超标」,状态不变)
3. **录入人(可选 HIGH 场景)**:AI 预检页填农残 0.15 → HIGH 60 分「疑似高农药残留」→ 核对页红色告警强烈建议人工复核 → 按步骤 4~5 发起修改并获批,演示 HIGH 告警闭环
4. **核对人**:核对签名页查批次 → 看到 AI 风险提示(含各维度明细与模型版本)后人工复核 → 点"从 IPFS 取回文件核对" → 核对签名(COUNTER_SIGNED,展示"AI 只辅助、人工决策")
5. **录入人**:修改复核页上传新版本文件 → 提交修改请求(PENDING)
6. **审核人**:修改复核页查看请求 → 批准(版本 v2 追加,v1 标 DEPRECATED)
7. **审核人**:锁定与凭证页 → 锁定发证(FINALIZED,展示凭证二维码)
8. **消费者**:消费者验证页输批次号 + 选文件 → MATCH(可再试篡改文件看 MISMATCH)
9. **监管方**:监管审计页查全版本历史(两个版本完整可见);AI 预检页可查看结论并核验报告哈希
