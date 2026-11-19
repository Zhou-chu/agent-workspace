# Testing and hosted quality checks

- `npm run check:architecture` checks browser, frontend gateway, server, connector, deployment and storage runtime boundaries. Their public interfaces are HTTP/process protocols or the exact storage adapter entry. Node built-ins are not allowed in browser code; only the WebSocket transport may import its exact locked runtime package. Unresolved imports and cycles fail CI.
- `node --test test/api-session-bindings.test.mjs`: owner-only operator lifecycle, cross-origin denial, stale-write rejection, immutable replay inspection and zero host dispatch.

- `node --test test/core-session-bindings.test.mjs`: exact task/default selection, no implicit or untrusted peer routing, authorization/revocation, exclusive session scope, generation and stale CAS, legacy migration, durable receipt replay. SQLite selection evidence is not native execution.
- `node --test test/core-workspace.test.mjs test/api-workspace.test.mjs`: persistence, identity, room scope, alerts vs passive chat, idempotency, trusted decisions and lifecycle transitions.
- `node --test test/mcp-chat.test.mjs test/api-task-artifacts.test.mjs test/ui-integration.test.mjs`: chat and explicit decision MCP semantics, task artifact authorization, immutable downloads, and lost-response retry. Local fixtures are not real model turns or remote artifact transfers.
- `node --test test/connector-status.test.mjs`: host heartbeat and approved status-only action, recovery from a lost receipt, token revocation. No models or arbitrary execution.
- `cd frontend && npm ci --ignore-scripts && npm test && npm run build`: standalone UI contracts and exact static artifact; the separate **Frontend CI / Frontend build and tests** check needs no backend install. These tests do not certify real browser/mobile rendering.
- `node --test test/deploy-desktop.test.mjs`: exact GitHub main/CI selection, loopback defaults and rollback-related configuration. Does not certify deployment.
- `npm test`: backend and cross-module regression (including UI/HTTP/SQLite); GitHub CI runs it on Node 24 on Linux and Windows.
- `mkdir -p coverage && npm run coverage`: generate combined frontend and backend LCOV for SonarQube Cloud. The scanner is a separate workflow with a waiting quality gate and cannot consume secrets for a fork pull request. Enable after the project is imported and configured: repository variable `SONAR_ENABLED=true`, repository secret `SONAR_TOKEN` scoped to this project, automatic analysis disabled if Workflows are used. An unconfigured, skipped workflow is not a passing Sonar quality gate.
- The desktop deployer uses the exact successful main push run of `ci.yml`; it does not certify Sonar results. Runtime credentials, caches and data directories are outside releases.

On main, the independent coverage reconciliation compares the exact Sonar revision and scanner's LCOV input. Missing or malformed individual metrics do not erase other verified measures; omissions are summarized using fixed metric names and reason codes, never raw response contents. If the analysis identity is not stable, only the verified hosted LCOV fallback is shown. The diagnostic does not override the scanner's quality gate.

真人 IM 首轮（Node 24，两个独立浏览器上下文）：

```sh
npm ci --ignore-scripts
npm --prefix frontend run build
npm --prefix e2e ci --ignore-scripts
npx --prefix e2e --no-install playwright install --with-deps chromium
npm --prefix e2e test
```

浏览器测试启动不同端口的前端、API/WebSocket 服务和临时私有存储。通过网页创建第二个真人账号，不用两个标签页复用 owner 身份；观察真实 WebSocket 帧后验证对端 UI，并实测重连补齐。录音在 Chromium 使用测试音频设备，不代表真机麦克风或实时通话。浏览器下载内容逐字节校验。存储自身另有构建和 Linux/Windows CI。
