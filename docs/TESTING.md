# Testing and hosted quality checks

- `npm run check:architecture` checks the static JavaScript module graph once per CI run on Linux. `web/`, `server/`, `connector/` and `deploy/` may import only their own local modules; their integration uses the existing HTTP and process protocols. Browser modules cannot import Node built-ins, and production runtimes cannot import npm packages. Unresolved imports and cycles fail CI. There is no exception baseline. The gate does not analyze PowerShell/HTML or computed module specifiers. The `test/architecture-gate.test.mjs` fixtures prove the CLI accepts valid edges and exits nonzero on violations.

- `node --test test/core-workspace.test.mjs test/api-workspace.test.mjs`: persistence, identity, room scope, alerts vs passive chat, idempotency, trusted decisions and lifecycle transitions.
- `node --test test/mcp-chat.test.mjs test/api-task-artifacts.test.mjs test/ui-integration.test.mjs`: chat and explicit decision MCP semantics, task artifact authorization, immutable downloads, and lost-response retry. Local fixtures are not real model turns or remote artifact transfers.
- `node --test test/connector-status.test.mjs`: host heartbeat and approved status-only action, recovery from a lost receipt, token revocation. No models or arbitrary execution.
- `node --test test/ui-contract.test.mjs`: UI message semantics and exact local payloads. These tests do not certify real browser/mobile rendering.
- `node --test test/deploy-desktop.test.mjs`: exact GitHub main/CI selection, loopback defaults and rollback-related configuration. Does not certify deployment.
- `npm test`: release-candidate regression; GitHub CI runs it on Node 24 on Linux and Windows.
- `mkdir -p coverage && npm run coverage`: generate LCOV for SonarQube Cloud. The scanner is a separate workflow with a waiting quality gate and cannot consume secrets for a fork pull request. Enable after the project is imported and configured: repository variable `SONAR_ENABLED=true`, repository secret `SONAR_TOKEN` scoped to this project, automatic analysis disabled if Workflows are used. An unconfigured, skipped workflow is not a passing Sonar quality gate.
- The desktop deployer uses the exact successful main push run of `ci.yml`; it does not certify Sonar results. Runtime credentials, caches and data directories are outside releases.

On main, the independent coverage reconciliation compares the exact Sonar revision and scanner's LCOV input. Missing or malformed individual metrics do not erase other verified measures; omissions are summarized using fixed metric names and reason codes, never raw response contents. If the analysis identity is not stable, only the verified hosted LCOV fallback is shown. The diagnostic does not override the scanner's quality gate.
