# Deterministic session binding receipts

Goal: demonstrate explicit routing and durable selection without a native adapter or executable queue. This is a core module increment only.

1. Add SQLite core tests driving owner-only `store.sessionBindings.set` (room/Agent, optional task), `retire` and `route`. Verify explicit task precedence/no fallback, authorization, stable history, and CAS/generation guards. Observe red against the existing core, then implement in `server/session-bindings.mjs`.
2. Add immutable per-reminder route receipts inside `store.send`'s existing transaction for human-to-owned-Agent structured mentions only. No dispatcher, transport API, or background registration; ordinary chat, legacy reminders and untrusted peer messages do not create a route.
3. Check membership/Agent/host and task eligibility. Retire bindings on corresponding revocation, prevent a previously used native identity from crossing Agent or room boundaries, and never update old receipts. Run scoped L2 core, HTTP and MCP checks; run the full deterministic candidate only once after focused checks.
