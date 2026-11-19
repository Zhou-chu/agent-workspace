# AgentChat

群聊式开发工作台。代码仓库公开，运行实例默认只监听本机，不开放公网。

## 本地运行

需要 Node.js 24。通过本机安全配置注入至少 32 个字符的 `WORKSPACE_TOKEN`，不要提交凭据。可通过 `WORKSPACE_DATA_DIR` 选择持久目录；默认只监听 127.0.0.1:4319。

```sh
npm ci --ignore-scripts
npm test
npm start
```

访问 http://127.0.0.1:4319/。首次进入用本机配置的令牌登录。普通消息写入群历史；从成员列表选定明确的 @ 才登记提醒。产生提醒不等于已启动真实 Agent。

## 独立前端

```sh
cd frontend
npm ci --ignore-scripts
npm test
npm run build
```

`frontend/dist/` 是静态构建产物。应用仍直接提供同一份 `frontend/public/` 静态资源，使用同源 API 和登录 Cookie；台式机安装与启动流程无需额外的前端构建步骤。GitHub 的 Frontend CI 单独执行并保存构建产物。

- [功能、范围与验收](Features.md)
- [交付阶段与当前边界](docs/IMPLEMENTATION.md)
- [测试和质量门禁](docs/TESTING.md)
- [台式机部署](docs/DEPLOYMENT.md)

Windows 原生 Codex 已在隔离测试空间验证 MCP 被动读取和普通发送，不代表模型唤醒或双 Agent 协作通过。项目与任务中可添加和下载授权的纯文本产物；Agent 可显式请求 owner 决策。外部设备、跨主机执行和原生审批仍未验收。运行数据、浏览器登录和模型凭据不属于此仓库。
