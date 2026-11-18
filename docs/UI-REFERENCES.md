# Editorial workspace refresh

The Windows preview of `327cc1f` showed flat headings, mismatched Unicode navigation glyphs, a broad two-column sidebar (336 px at 1024 px), always-visible message action chrome, and an in-flow @ picker which reduced the visible phone transcript by 23%. The remedy is layout and information hierarchy, not a palette change.

| GitHub reference | Take | Do not copy |
| --- | --- | --- |
| [VoltAgent / awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | WIRED and Runway for editorial type scale and restraint; Vercel for precise monochrome contrast. | Marketing heroes, grids, brand assets, proprietary fonts. |
| [GitHub Primer Primitives](https://github.com/primer/primitives) | Semantic surfaces, typography roles, control sizes and states instead of ad hoc values. | Primer's colour identity or a bundled UI runtime. |
| [Vercel Chatbot](https://github.com/vercel/chatbot) | Conversation alignment, calm whitespace and an integrated composer. | One-person chatbot information architecture. |
| [Mattermost](https://github.com/mattermost/mattermost) | Room index, selected channel, secondary thread controls and consistent collaboration navigation. | Visual chrome density and unrelated product features. |

## Acceptance

- 1440 desktop: distinguish navigation, room index and conversation at first glance. Feed, composer and header align; message text is readable rather than stretching across the pane. Other pages share the shell and heading hierarchy.
- 1024 tablet and 390 phone: room index doesn't crowd the feed; one-pane navigation on phone; no horizontal overflow; mention picker doesn't collapse the feed; 44 px primary touch controls.
- Light/dark and keyboard: visible contrast, active state, focus, a stable message composer and secondary reply/thread actions available without hover. No decorative status is presented as an operational event.
- Existing login, room, chat, reply, structured mention, task, decision and host behaviors stay unchanged unless an explicit interaction defect is fixed. Ordinary text `@` and ordinary replies never create reminders. Verify with targeted browser and actual HTTP/SQLite tests; emulated viewport is not a physical device.
