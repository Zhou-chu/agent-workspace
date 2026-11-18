# Host status connector

This dependency-free Node 24 connector reports **only** a host heartbeat and results of owner-requested status checks. It does not read chat, wake or drive models, discover credentials, execute commands, or send files. Its status payload is limited to the platform label and connector version.

1. Register a host as the authenticated Workspace owner and securely retain the one-time **host** token (not the owner login or an Agent token).
2. In that host's local process environment set `WORKSPACE_CONNECTOR_ORIGIN` to the trusted HTTPS origin or to loopback HTTP (for example, `http://127.0.0.1:4319`). HTTP on non-loopback addresses and redirected transport are refused. Set `WORKSPACE_CONNECTOR_TOKEN` from your local credential mechanism, not in the command, repository, or chat. Set `WORKSPACE_CONNECTOR_STATE_DIR` to a private writable local directory unique to this enrollment.
3. Run `node connector/status.mjs`. Default polling is 10 seconds; `WORKSPACE_CONNECTOR_POLL_MS` accepts 1000–30000 ms. Stop with Ctrl-C.

Run only one connector process per state directory. The local SQLite journal binds the origin and host token fingerprint and preserves the exact request and response custody across restart. After a transport interruption, the connector resumes the same receipt before requesting a new one; the server remains the authoritative state. Five consecutive temporary failures cause nonzero exit instead of unbounded fast retry. Authentication rejection stops polling. Revoke the old host and use a fresh local state directory for a new enrollment after reconciling any old pending checks.

A loopback HTTP check does not certify a separate host, Tailnet, or any native Harness.
