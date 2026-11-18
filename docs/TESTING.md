# Testing and hosted quality checks

- `node --test test/core-workspace.test.mjs test/api-workspace.test.mjs`: persistence, identity, room scope, alerts vs passive chat, idempotency, trusted decisions and lifecycle transitions.
- `node --test test/connector-status.test.mjs`: host heartbeat and approved status-only action, recovery from a lost receipt, token revocation. No models or arbitrary execution.
- `node --test test/ui-contract.test.mjs`: UI message semantics and exact local payloads. These tests do not certify real browser/mobile rendering.
- `node --test test/deploy-desktop.test.mjs`: exact GitHub main/CI selection, loopback defaults and rollback-related configuration. Does not certify deployment.
- `npm test`: release-candidate regression; GitHub CI runs it on Node 24 on Linux and Windows.
- `mkdir -p coverage && npm run coverage`: generate LCOV for SonarQube Cloud. The scanner is a separate workflow with a waiting quality gate and cannot consume secrets for a fork pull request. Enable after the project is imported and configured: repository variable `SONAR_ENABLED=true`, repository secret `SONAR_TOKEN` scoped to this project, automatic analysis disabled if Workflows are used. An unconfigured, skipped workflow is not a passing Sonar quality gate.
- The desktop deployer uses the exact successful main push run of `ci.yml`; it does not certify Sonar results. Runtime credentials, caches and data directories are outside releases.

On main, the independent coverage reconciliation compares the exact Sonar revision and scanner's LCOV input. Missing metrics are reported as unavailable; failure of the diagnostic does not override the scanner's quality gate.
