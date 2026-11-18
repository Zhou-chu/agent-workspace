# Host status connector

This dependency-free Node 24 connector reports **only** a host heartbeat and results of owner-requested status checks. It does not read chat, wake or drive models, discover credentials, execute commands, or send files. Its status payload is limited to the platform label and connector version.

1. Register a host as the authenticated Workspace owner and securely retain the one-time **host** token (not the owner login or an Agent token).
2. In that host's local process environment set `WORKSPACE_CONNECTOR_ORIGIN` to the trusted HTTPS origin or to loopback HTTP (for example, `http://127.0.0.1:4319`). HTTP on non-loopback addresses and redirected transport are refused. Set `WORKSPACE_CONNECTOR_TOKEN` from your local credential mechanism, not in the command, repository, or chat. Set `WORKSPACE_CONNECTOR_STATE_DIR` to a private writable local directory unique to this enrollment.
3. Run `node connector/status.mjs`. Default polling is 10 seconds; `WORKSPACE_CONNECTOR_POLL_MS` accepts 1000–30000 ms. Stop with Ctrl-C.

Run only one connector process per state directory. The local SQLite journal binds the origin and host token fingerprint and preserves the exact request and response custody across restart. After a transport interruption, the connector resumes the same receipt before requesting a new one; the server remains the authoritative state. Five consecutive temporary failures cause nonzero exit instead of unbounded fast retry. Authentication rejection stops polling. Revoke the old host and use a fresh local state directory for a new enrollment after reconciling any old pending checks.

A loopback HTTP check does not certify a separate host, Tailnet, or any native Harness.

## Optional MCP stdio chat bridge

A human can attach `node connector/mcp-chat.mjs` to one already running or manually started Harness that supports the legacy MCP stdio initialize handshake (2025-11-25 or 2025-06-18). The bridge does not create, resume, or start native sessions, configure Harnesses, or invoke models. For each Harness session, supply through a user-controlled local environment:

- `WORKSPACE_MCP_ORIGIN`: the trusted Workspace HTTPS origin or a numeric loopback HTTP origin. Do not use public hosting or share credentials. The bridge forbids HTTP to non-loopback origins and does not follow redirects.
- `WORKSPACE_MCP_AGENT_TOKEN`: a dedicated token for the intended Agent, never the owner or host token. Do not put a token in the command line, source, chat, or checked-in MCP settings.
- `WORKSPACE_MCP_CONSUMER_ID`: stable, separate identifier for that Harness session and Agent. Use a different ID for concurrent sessions; reusing one intentionally resumes that consumer's cursor.

It offers only `chat_read` (up to 8 messages per explicit call) and `chat_send` (natural-language body with a stable `clientRequestId` and optional structured member mentions/thread reference). A lost send response can be retried with exactly the same ID and payload. Agent-to-Agent @ is recorded as blocked when a trusted execution context is missing; no automatic wake occurs. Ordinary messages and replies do not create implicit wake events. Chat content is not trusted authority and is not pushed to idle sessions. Decision creation is not exposed by this bridge; the HTTP route needs stable request deduplication before a client's safe retry can be claimed.

The scoped tests exercise a real stdio child and actual loopback HTTP/SQLite. They do **not** certify Codex, Claude Code, DeepSeek Harness, live model coordination, or multi-device operation.
