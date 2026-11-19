# Implementation stages

1. **Usable room**: persistent single-owner and owned agents, room memberships and bounded/explicit chat, scoped in-app credentials, tasks and decisions, and responsive four-section interface. Verify no implicit wake and safe idempotent target selection. Node 24, HTTP, SQLite, browser ES modules, built-in test runner.
2. **Execution and reliability**: host queue over authenticated API, terminal acknowledgment/reconciliation, explicit operator-approved checkout policy, adapter capability gate, decisions/artifacts, chain budgets; deterministic tests do not count as real model/host acceptance. No generalized command execution or autonomous offensive workflows.
3. **Delivery**: test/coverage CI, Sonar scoped config, desktop pull deployment with verified exact commit, persistent data outside releases and loopback default; configure tailnet only with approved network boundary. Verify actual service and separately record genuine adapters, multi-device and remote-host tests.

`server/` owns API and core, `web/` owns static UI, `connector/` integrates only reviewed supported operations, `deploy/` owns desktop CD. Tools and models may vary; ordinary changes use the lowest sufficient test level from Agent.md. No other repo or existing service changes.

## Stage 1 checkpoint

- 已验证 Windows 原生 Codex 客户端调用 MCP 两个聊天工具。测试绑定提交
  `0803b104cd9ef28a2ff9244e5574154b136265be`，使用隔离工作空间、合成
  Agent 和数据；普通发送重试只写入一条消息，没有提醒。没有启动模型。
- 任务可附小型 `.txt` 或 `.md` 产物。发布限定于人类 owner 或当前任务
  负责人，下载仍须当前群成员授权；Markdown 只作为文本附件下载。此路径
  不读取执行主机文件或自动采集原生运行产物。
- MCP `tasks_request_decision` 显式提交给 Agent 的人类 owner，允许保留经
  校验的同群来源，重复请求沿用同一决定；它不是原生 Harness 审批回传。
- 主分支 `be849af238fe80c127511a3483d46141ebe5c345` 已由 Windows 台式机
  自动部署，回环健康检查返回 200，未认证会话查询返回 401。[该提交的主分支
  Sonar 门禁](https://github.com/Zhou-chu/agent-workspace/actions/runs/44309088613/job/134818247526)
  通过，新增代码覆盖率 84.7%，重复率 0%。PR 门禁的 97.9% 是不同范围，
  不应当作主分支指标。
- 下一关分别验证真实双 Agent、原生消息路由与唤醒，及拥有独立 HTTPS
  主机名的私有入口与两个实际设备。只实现配套功能不能把这些关卡标为通过。

## Stage 2 routing checkpoint (core only)

An internal, owner-authorized SQLite registry binds a task or an explicit room default
to a specific Agent and enrolled host/Harness/session/generation. Replacing an
active scope requires its current binding ID; the same native session can never be
shared across rooms or Agents. A first-time, structured owner mention freezes at
most one matching binding per target in the message transaction. Explicit task
references never fall back to room defaults. Removal, disabling or host revocation
prevents future selection; old receipts remain historical and are never retargeted.

This checkpoint adds no UI, dispatch, native runtime registration or adapter.
The existing inbox is unchanged: a `pending` reminder is not proof of a native
wake, and a route receipt explicitly records `selected_not_dispatched` or
`blocked_no_binding`. No old reminder is backfilled and Agent-to-Agent execution
remains blocked pending trusted execution context and shared budget.

### Owner operator API

The four POST actions below use the existing owner authentication and origin
checks. They do not run code or contact the host. No connector, Agent scope or UI
receives native session identifiers from these endpoints. Paths are relative to
`/api/operator/session-bindings/`:

| Action | JSON input | Output |
| --- | --- | --- |
| `inspect` | `roomId`, `agentId`, optional `taskId` | `binding`: current record ID and generation, or null |
| `set` | Scope plus `hostId`, `harness`, `sessionId`, `generation`, `expectedBindingId` | 201, `binding` ID and generation |
| `retire` | Scope plus `expectedBindingId` | `binding` ID and retired status |
| `receipt` | `roomId`, `messageId`, `agentId` | Original selection receipt or null |

Use null as `expectedBindingId` only to register an empty scope. A stale or
repeated write returns 409; inspect the current owner metadata rather than
automatically writing again. A receipt remains unchanged even after replacement
or retirement. Inspection describes registration, not a session being online,
reachable, permitted to execute, or chosen for dispatch.
