# Implementation stages

1. **Usable room**: persistent single-owner and owned agents, room memberships and bounded/explicit chat, scoped in-app credentials, tasks and decisions, and responsive four-section interface. Verify no implicit wake and safe idempotent target selection. Node 24, HTTP, SQLite, browser ES modules, built-in test runner.
2. **Execution and reliability**: host queue over authenticated API, terminal acknowledgment/reconciliation, explicit operator-approved checkout policy, adapter capability gate, decisions/artifacts, chain budgets; deterministic tests do not count as real model/host acceptance. No generalized command execution or autonomous offensive workflows.
3. **Delivery**: test/coverage CI, Sonar scoped config, desktop pull deployment with verified exact commit, persistent data outside releases and loopback default; configure tailnet only with approved network boundary. Verify actual service and separately record genuine adapters, multi-device and remote-host tests.

`server/` owns API and core, `web/` owns static UI, `connector/` integrates only reviewed supported operations, `deploy/` owns desktop CD. Tools and models may vary; ordinary changes use the lowest sufficient test level from Agent.md. No other repo or existing service changes.
