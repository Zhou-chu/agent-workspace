# AgentChat

群聊式开发工作台。代码仓库公开，运行实例默认只监听本机，不开放公网。

## 本地运行

需要 Node.js 24。前端与后端用两个独立进程运行：

```sh
npm ci --ignore-scripts
# 先从本机私密配置向环境注入 WORKSPACE_TOKEN
WORKSPACE_PUBLIC_ORIGIN=http://127.0.0.1:4320 npm start
# 在另一个终端运行
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
AGENTCHAT_FRONTEND_PORT=4320 AGENTCHAT_BACKEND_ORIGIN=http://127.0.0.1:4319 npm --prefix frontend start
```

后端端口 4319 只提供 API、WebSocket 和健康检查，不提供静态页面。前端端口 4320 只提供独立构建产物，并把同源的 API/WebSocket 转给指定后端。访问前端地址，用本机配置密钥登录；owner 可在设置中生成另一位真人的独立登录密钥。

- [真人 IM、浏览器验收与实施顺序](docs/IM-BASELINE.md)
- [独立前端](frontend/README.md)
- [独立存储](storage/README.md)
- [功能、范围与验收](Features.md)
- [交付阶段与当前边界](docs/IMPLEMENTATION.md)
- [测试和质量门禁](docs/TESTING.md)
- [台式机部署](docs/DEPLOYMENT.md)

当前顺序是真人 IM、再接入 Agent、再验证智能编排。旧试验入口不等于当前产品已接入 Harness。运行数据、浏览器登录和模型凭据不属于此仓库。
