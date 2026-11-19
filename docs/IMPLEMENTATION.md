# Implementation stages

1. **Usable room**: persistent single-owner and owned agents, room memberships and bounded/explicit chat, scoped in-app credentials, tasks and decisions, and responsive four-section interface. Verify no implicit wake and safe idempotent target selection. Node 24, HTTP, SQLite, browser ES modules, built-in test runner.
2. **Execution and reliability**: host queue over authenticated API, terminal acknowledgment/reconciliation, explicit operator-approved checkout policy, adapter capability gate, decisions/artifacts, chain budgets; deterministic tests do not count as real model/host acceptance. No generalized command execution or autonomous offensive workflows.
3. **Delivery**: test/coverage CI, Sonar scoped config, desktop pull deployment with verified exact commit, persistent data outside releases and loopback default; configure tailnet only with approved network boundary. Verify actual service and separately record genuine adapters, multi-device and remote-host tests.

`server/` owns API and core, `frontend/` owns the independently installed, tested and built static UI, `connector/` integrates only reviewed supported operations, `deploy/` owns desktop CD. Tools and models may vary; ordinary changes use the lowest sufficient test level from Agent.md. No other repo or existing service changes.

## Stage 1 checkpoint

- 已验证 Windows 原生 Codex 客户端调用 MCP 两个聊天工具。测试绑定提交
  `0803b104cd9ef28a2ff9244e5574154b136265be`，使用隔离工作空间、合成
  Agent 和数据；普通发送重试只写入一条消息，没有提醒。没有启动模型。
- 任务可附小型 `.txt` 或 `.md` 产物。发布限定于人类 owner 或当前任务
  负责人，下载仍须当前群成员授权；Markdown 只作为文本附件下载。此路径
  不读取执行主机文件或自动采集原生运行产物。
- MCP `tasks_request_decision` 显式提交给 Agent 的人类 owner，允许保留经
  校验的同群来源，重复请求沿用同一决定；它不是原生 Harness 审批回传。
- 下一关分别验证真实双 Agent、原生消息路由与唤醒，及拥有独立 HTTPS
  主机名的私有入口与两个实际设备。只实现配套功能不能把这些关卡标为通过。
