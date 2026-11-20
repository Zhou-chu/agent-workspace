# Human IM Contacts and Unread Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans; work from the tests listed below.

**Goal:** Let existing authenticated humans find one another, mutually confirm friendship, open a private two-person conversation, and catch up on unread messages across disconnections.

**Architecture:** Keep the standalone frontend, HTTP/WebSocket backend and storage adapter. Put friendship, DM membership and per-human read cursors in the existing SQLite authority. WebSocket sends scoped refresh hints; messages, unread state and permissions still come from HTTP.

**Tech Stack:** Node 24, SQLite, standalone browser ESM, Chromium Playwright.

**Spec:** This plan captures the approved next slice of [IM baseline](../../IM-BASELINE.md). A later slice covers group roles and invitation review. It does not replace the separate MCP, storage or desktop rollout work.

## Global constraints

- Keep invited human key authentication for this slice; no public registration or Agent DM.
- Keep Group and Agent behavior, existing media flow and CI gates.
- Existing rooms migrate without data loss. Direct messages belong only to the two participants; the workspace owner has no unrelated DM access.

## Tasks

- [ ] Backend: add contact search/social lifecycle in the SQLite server and expose `/api/contacts`, `/api/contacts/search`, `/api/contacts/request`, `/api/contacts/accept`. Write failing domain/API tests before implementation. Return only human IDs, display names and relationship state.
- [ ] Backend: expose `POST /api/direct` with `{humanId}` and `POST /api/rooms/:id/read` with `{cursor}`. Test duplicate opening, explicit reciprocal confirmation, room scope, monotonic reads and callers excluded from a DM. Emit scoped contact/room hints.
- [ ] Frontend: use the contact endpoints to render find/request/accept/open actions, list group + direct conversations and unread totals. Acknowledge only rendered, foreground room progress, never unrelated rooms or thread cursors. Use focused frontend tests for route/state behavior.
- [ ] Integration: extend the live Chromium spec to create separate sessions, confirm friendship by UI, send in a DM and recover 124 offline messages and an older recall across three pages while keeping unread visible in a different room. Keep existing media tests. Re-run SQLite/HTTP tests, standalone frontend build/tests, architecture check, and browser before a draft checkpoint.
- [ ] Later: group role hierarchy and invitation approval with three distinct users, after this slice is verified. Do not mark deployment or Tailnet verification complete from hosted CI.

## Review focus

Reverse requests cannot substitute for acceptance; no private-room visibility or default owner override; background room notifications do not mark history read; reconnect works across multiple page boundaries; unread cannot regress after stale acknowledgment or count a sender's own messages.
