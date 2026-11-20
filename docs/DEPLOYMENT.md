# AgentChat desktop delivery

This is a pull deployer for a Windows account that owns the application. The
GitHub-hosted CI runner has no access to the desktop or its secrets. This
document describes a release procedure, not an assertion that the service or
its tailnet entry is already deployed.

## Preconditions

- A trusted, reviewed public GitHub repository with a `main` branch; protect
  `main` and require review for application or workflow changes when available.
  Anyone who can run unreviewed code on `main` can affect this deployment.
- Node.js 24+ and Git from their official distributions, on the logged-in
  user's PATH. Public GitHub API and HTTPS Git must be reachable; no GitHub
  credential is needed on the desktop.
- The repository runs the selected workflow on `push` to `main`. Its required
  tests, build and enforced quality checks need to fail the run on failure.
  The default workflow filename is `ci.yml`. An independent Sonar dashboard
  or advisory result is not a gate unless wired into this workflow.
- An app-specific strong owner token, held in approved local storage and
  passed to this supervisor's environment as `WORKSPACE_TOKEN` (32 or more
  non-whitespace characters). Do not type it into a shell command, store
  it in a scheduled-task argument, or commit it to the repository.

## Install a reviewed Windows release

From the reviewed checkout of `Zhou-chu/agent-workspace`, only after the
exact `main` delivery CI succeeded, the signed-in owner can register the
same-user limited logon task. This does not change firewall, Tailscale or
PowerShell security settings. If execution policy or Task Scheduler refuses,
stop rather than bypassing it. Do not run the installer as an administrator:

```powershell
powershell.exe -NoProfile -File .\deploy\windows-bootstrap.ps1 -Mode Check
powershell.exe -NoProfile -File .\deploy\windows-bootstrap.ps1 -Mode Install
```

The installer generates a random 256-bit application credential and stores
only Windows DPAPI CurrentUser ciphertext in the same user's local profile.
It pins existing Node and Git executables by absolute path, preferring
their standard Program Files installations. The check command runs before
any installation and writes no app files or tasks.
No token is passed as a command argument, written to task state, or printed.
After `/healthz` succeeds, the actual Windows owner can run the installed
script locally to open a masked dialog, then explicitly click **Reveal on
this device** to use the key for `http://127.0.0.1:4319/`:

```powershell
& "$env:LOCALAPPDATA\AgentWorkspace\bootstrap\windows-bootstrap.ps1" -Mode ShowOwnerToken
```

Do not invoke reveal through remote agents, logs, screenshots, shared screens
or recordings. Close the dialog after using the key. Clipboard history may
keep copied secrets; avoid copying there when possible. The installer
refuses to overwrite an existing task or credential. If installation fails
partway, inspect the dedicated bootstrap folder and scheduled task before
retrying so recovery does not rotate or erase a credential accidentally.

## Run the supervisor manually

Copy the reviewed supervisor from an explicitly selected release into a
user-owned directory outside the runtime checkouts. Pin it to the actual
`WORKSPACE_REPOSITORY` in the supervised process environment; optional
`WORKSPACE_CI_WORKFLOW`, `WORKSPACE_CD_ROOT` (absolute), and
`WORKSPACE_PORT` (default 4319). Keep the default CD root in a user-owned
directory. The Windows root defaults to `%LOCALAPPDATA%\AgentWorkspace`.

Run the reviewed copy in a foreground user-owned process:

```powershell
node .\desktop.mjs
```

First smoke-test under the same logged-in account. For continuous use, run it
at logon under that same account (one process, no elevation), with the
environment provisioned by the approved local credential mechanism. The
supervisor polls every four minutes. Starting the process, or registering it
at logon, is an installation action; this repository does not register a
scheduled task itself.

The supervisor independently reads current `main`, checks the latest exact
`push` run for that SHA from the pinned workflow and repository, and checks
that the checkout resolves to the same 40-hex SHA. A queued or failed run,
network/API failure, an unrelated PR or fork, an existing modified release,
or a failed smoke test does not switch versions. An isolated candidate uses
an ephemeral port, a throwaway token and separate empty data. Runtime
variables inherited by the application are restricted; other desktop
credentials are not passed through the process environment.

After smoke passes it stops only its owned child, captures an offline copy
of existing app data, then starts the candidate on loopback. If activation
fails, it attempts to restart the last healthy release with the same data;
a backup is retained but not silently restored. Do not ship incompatible
migrations with the automatic path. They require a tested migration/rollback
plan. `releases/`, `data/`, `backups/` and `active.json` are distinct.
Do not delete any of them just to force a redeploy. Discarded temporary
smoke data only belongs to that smoke run.

If interrupted, first check the supervised process and loopback owner.
A leftover lock means the supervisor refuses to create a duplicate.
Do not remove the lock until both previously owned processes have been
verified stopped. If a candidate fails it is not retried automatically with
the same CI run identity, avoiding needless restart cycles. Inspect restore
and rollback before resuming; a running previous release is preferred to
silently removing data.

## Verify and access

- Check the supervisor records the full verified SHA and CI run ID;
  independently check `active.json` and the same upstream CI run.
- On the desktop, open `http://127.0.0.1:4319/` and verify `/healthz`
  plus an authenticated smoke action. A listener alone does not prove app
  authorization, and a single local browser does not prove cross-device use.
- Keep the listener on loopback. Tailnet delivery requires a separate approved
  private proxy/tailnet configuration with application authentication still
  enforced. Use secure cookies when serving
  exclusively via HTTPS, setting both `WORKSPACE_SECURE_COOKIES=1` and the
  exact `WORKSPACE_PUBLIC_ORIGIN=https://…` in an approved manual setup.
  The Windows installer above is loopback-only and does not configure an
  origin or proxy. Do not enable a public Funnel, trust arbitrary
  proxy identity headers, or expose the process via an unrestricted bind or
  firewall rule.
- On another actual device after private ingress is configured, verify
  authenticated access, rejected unauthenticated requests, and an explicitly
  selected room flow. Never distribute native Harness credentials this way.

## Deployment test

```powershell
node --test test/deploy-desktop.test.mjs
powershell.exe -NoProfile -File .\test\deploy-bootstrap.test.ps1
```

These deterministic tests validate trust selection, input validation,
loopback-only configuration and activation/rollback ordering. They do not
activate GitHub, publish data or demonstrate a real installation.

### Split AgentChat runtime candidate

For releases with both `server/api.mjs` and `frontend/gateway/index.mjs`, the
updated supervisor prepares that exact checkout using its frozen production
dependencies (the selected Node 24 installation must include npm; lifecycle
scripts disabled) and the frontend build. It runs the gateway on the existing
configured loopback port and the API on a distinct loopback port. The reverse
proxy should continue to target the gateway, not the backend. An already
installed copy of the old supervisor is **not** updated by fetching main.

Before it stops the previous runtime, the supervisor launches a disposable
copy of the same pair, loads built HTML, signs into the API through the
gateway, and requires an authenticated WebSocket notification for a disposable
message. The trial uses fresh data and a generated test key, not the real
account's credential. The new live pair must also expose the built HTML and
API through the gateway. It does not send test messages or authenticate as
the owner against live data. Both owned children are stopped on failure or
shutdown. Historical pre-split releases remain launchable by the new controller.

The Windows installation and existing task are unchanged by these code/test
changes. Hosted Windows process coverage, reviewed installation handoff,
Tailnet origin, and real-device acceptance are distinct verification steps.

The Windows bootstrap's `Check` and `Install` require a complete Node
distribution. They validate `node.exe` and its adjacent bundled npm CLI
together; `Check` reports `npmValidated` without editing the host. `Run`
revalidates both pinned paths before reading the owner key. An older
`runtime.json` lacks the npm pin; plan a reviewed handoff of the bootstrap,
supervisor and manifest together **before** switching to a split release.
Fetching main does not perform that migration or change the existing task
and its local credential.

The staged npm install uses the reviewed lockfile, public npm registry and
temporary empty user/global configs and cache. It rejects a project
`.npmrc` and does not read or edit the user's npm config. Package fetch must
work on the target host; failure leaves the existing release alone during
candidate smoke.

The gateway's `/healthz` only means the gateway is responsive. For a
non-secret end-to-end HTTP check also verify that `/api/session` at the
same origin returns HTTP 401 with Content-Type application/json without
credentials. The authenticated WebSocket trial is separately run against
disposable data. The periodic controller checks child processes when it
polls; it is not an immediate or continuous runtime liveness monitor.
