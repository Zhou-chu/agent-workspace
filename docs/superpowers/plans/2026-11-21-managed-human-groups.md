# Managed Human Groups Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for the steps below.

**Goal:** Complete the traditional IM group's creation, member governance, reviewed invitations, announcements, and departure workflow without changing the authority model of existing Agent workspaces.

**Architecture:** Managed human groups are explicitly created from existing authenticated accounts and use existing group chat storage. A per-room authority model is separate from the global workspace operator and Agent roles. HTTP owns permissions and mutations; WebSocket sends no privileged content, only scoped invalidation signals.

**Tech stack:** Node 24, SQLite, existing standalone frontend, Chromium + Playwright.

**Spec:** Phase 2 of the approved [human IM baseline](../../IM-BASELINE.md).

## Global constraints

- Never auto-promote anyone in General or older workspace rooms; their existing Agent features/authority remain intact. No new Agent privileges or widening of private conversation scope.
- A new member is admitted only after applicable manager review and then the member's explicit acceptance. Joining allows reading this group's existing history; disclose before acceptance.
- The current owner cannot leave before transfer. Owner-only appointment, demotion, and transfer; an admin can only remove regular members; everyone but the owner can leave.
- Keep the standalone frontend, backend, storage and hosted tests separate. No deployment or production data migration from this task.

## Tasks

- [ ] Red–green role matrix and durable room policy using `server/im-groups.mjs`, real SQLite tests and scoped HTTP integration. Add managed room discriminator to `GET /api/rooms`; check legacy/raw route, rollback, private room and Agent isolation.
- [ ] Red–green invitation states and scope. Build `/api/im/groups`, `/api/im/group-invites`, scoped approve/reject/accept/decline, announcement history, and role mutation routes. Test duplicate requests, stale roles, and session scoped refresh.
- [ ] Build the managed human room interface separate from the legacy member panel. Human friends and direct chats must still work. Show role-specific actions, clear review state, explicit acceptance/history disclosure, confirmation on transfer, removal and exit.
- [ ] Add a three-user hosted Chromium flow: Alice as owner, Bob as a regular member then admin and new owner, Carol as approved invitee, then removed with no remaining access. Original human media + private offline scenarios remain in the gate. Run exact hosted Frontend, Storage, CI, Playwright and Sonar before claiming pass.

## Review focus

Role checks use current persisted actor and room state; invitation approvals can't add members by themselves; former owners lose privileged actions immediately; leave/removal removes view and media rights without deleting history; neither managed roles nor global operator can read unrelated private conversations.
