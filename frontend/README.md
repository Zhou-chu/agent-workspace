# AgentChat frontend runtime

Node 24+. The frontend builds and runs independently from the backend source, token, data directory, and database. Build and test it from the repository root:

```sh
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend test
npm --prefix frontend run build
AGENTCHAT_BACKEND_ORIGIN=http://127.0.0.1:4319 npm --prefix frontend start
```

The frontend listens on `127.0.0.1:4320` by default. Set `AGENTCHAT_FRONTEND_HOST` and `AGENTCHAT_FRONTEND_PORT` if needed. The explicitly configured backend must use a different port on loopback (IPv4 or IPv6). Serve both applications through the frontend origin: it serves `dist/` directly and relays `/api` and `/api/*` requests and `/ws` WebSocket upgrades to the fixed backend. Cookies and browser Origin/Host are relayed on those routes only. It neither terminates TLS nor opens remote network access. For TLS reverse proxy deployments configure the backend's `WORKSPACE_PUBLIC_ORIGIN` with the browser-visible HTTPS origin; keep the backend listener private.

The independent Frontend CI job requires tests and a build, then uploads a frontend-only artifact containing `dist/` and `gateway/index.mjs`. Extract them in the same directory and run `node gateway/index.mjs` with the same environment. `GET /healthz` checks only the frontend; use a separate private backend health probe for operational monitoring.
