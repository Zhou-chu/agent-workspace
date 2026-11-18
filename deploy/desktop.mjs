import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/;
const repoPattern = /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i;
const workflowPattern = /^[a-z\d][a-z\d_.-]{0,70}\.ya?ml$/i;
const apiOrigin = "https://api.github.com";
const loopback = "127.0.0.1";

function validatePin(repository, workflow) {
  if (!repoPattern.test(repository) || /\/\.{1,2}$/.test(repository)) throw new Error("Invalid pinned repository (owner/name required)");
  if (!workflowPattern.test(workflow)) throw new Error("Invalid pinned CI workflow filename");
}

export function deployedConfig(env = process.env) {
  const repository = env.WORKSPACE_REPOSITORY ?? "";
  const workflow = env.WORKSPACE_CI_WORKFLOW ?? "ci.yml";
  validatePin(repository, workflow);
  const token = env.WORKSPACE_TOKEN ?? "";
  if (token.length < 32 || /\s/.test(token)) throw new Error("WORKSPACE_TOKEN must be pre-provisioned with at least 32 non-whitespace characters");
  const root = env.WORKSPACE_CD_ROOT ?? join(env.LOCALAPPDATA || homedir(), "AgentWorkspace");
  if (!isAbsolute(root)) throw new Error("WORKSPACE_CD_ROOT must be absolute");
  const port = Number(env.WORKSPACE_PORT ?? "4319");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid application port");
  const publicOrigin = env.WORKSPACE_PUBLIC_ORIGIN || null;
  if (publicOrigin) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { /* reject below */ }
    if (parsed?.protocol !== "https:" || parsed.origin !== publicOrigin) throw new Error("WORKSPACE_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  return { repository, workflow, root, port, token, publicOrigin, secureCookies: Boolean(publicOrigin) || env.WORKSPACE_SECURE_COOKIES === "1" };
}

export function serviceEnv(config, dataDir, port, token) {
  const os = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:path|systemroot|windir|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(key)));
  return {
    ...os, NODE_ENV: "production", WORKSPACE_HOST: loopback, WORKSPACE_PORT: String(port),
    WORKSPACE_DATA_DIR: dataDir, WORKSPACE_TOKEN: token,
    WORKSPACE_SECURE_COOKIES: config.secureCookies ? "1" : "0",
    ...(config.publicOrigin ? { WORKSPACE_PUBLIC_ORIGIN: config.publicOrigin } : {})
  };
}

export async function exactMain({ repository, workflow }, fetcher = fetch) {
  validatePin(repository, workflow);
  const [owner, repo] = repository.split("/");
  const base = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/`, apiOrigin);
  const get = async (url) => {
    const response = await fetcher(url, {
      redirect: "error", signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agent-workspace-desktop-cd" }
    });
    if (!response.ok) throw new Error(`GitHub CI query failed (HTTP ${response.status})`);
    return response.json();
  };
  const ref = await get(new URL("git/ref/heads/main", base));
  const sha = ref?.object?.sha;
  if (ref?.object?.type !== "commit" || typeof sha !== "string" || !shaPattern.test(sha)) throw new Error("Invalid exact main commit");
  const url = new URL(`actions/workflows/${encodeURIComponent(workflow)}/runs`, base);
  url.search = new URLSearchParams({ branch: "main", event: "push", head_sha: sha, per_page: "20" });
  const result = await get(url);
  if (!Array.isArray(result?.workflow_runs)) throw new Error("Invalid CI result");
  const latest = result.workflow_runs.filter(run =>
    run?.event === "push" && run.head_branch === "main" && run.head_sha === sha &&
    String(run.head_repository?.full_name ?? "").toLowerCase() === repository.toLowerCase() &&
    Number.isSafeInteger(run.id) && run.id > 0
  ).sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") return null;
  return { sha, runId: latest.id };
}

export async function transition(state, candidate, ops) {
  if (state.active?.sha === candidate.sha) return state;
  await ops.smoke(candidate);
  await ops.stop();
  try {
    await ops.backup();
    await ops.start(candidate);
    const next = { active: candidate, previous: state.active ?? null };
    await ops.persist(next);
    return next;
  } catch (error) {
    await ops.stop();
    if (state.active) {
      try { await ops.start(state.active); }
      catch { throw new Error("Activation failed and previous service could not restart; preserve data and inspect manually", { cause: error }); }
    }
    throw error;
  }
}

function validateRelease(release) {
  if (typeof release?.sha !== "string" || !shaPattern.test(release.sha) ||
      !Number.isSafeInteger(release.runId) || release.runId < 1) throw new Error("Invalid release state");
  return release;
}

async function releaseState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    for (const key of ["active", "previous"]) if (state[key]) validateRelease(state[key]);
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { active: null, previous: null };
    throw error;
  }
}

function gitEnv() {
  return { ...serviceEnv({}, "", 4319, ""), WORKSPACE_TOKEN: "", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

const git = async (cwd, args) => (await execute("git", [
  "-c", "credential.helper=", "-c", "protocol.file.allow=never", ...args
], { cwd, env: gitEnv(), windowsHide: true, timeout: 90_000, maxBuffer: 512 * 1024 })).stdout.trim();

async function prepareRelease(config, release, releases) {
  validateRelease(release);
  const path = join(releases, release.sha);
  try {
    if (await git(path, ["rev-parse", "HEAD"]) === release.sha &&
        !(await git(path, ["status", "--porcelain", "--untracked-files=all"]))) return path;
    throw new Error("Existing release differs from verified commit; not overwriting");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = await mkdtemp(join(releases, ".incoming-"));
  try {
    await git(stage, ["init", "--quiet", "--template="]);
    await git(stage, ["fetch", "--no-tags", "--depth=1", `https://github.com/${config.repository}.git`, release.sha]);
    await git(stage, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    if (await git(stage, ["rev-parse", "HEAD"]) !== release.sha) throw new Error("Verified Git object and checkout differ");
    await rename(stage, path);
    return path;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function reserveLoopback(port = 0) {
  return new Promise((accept, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(port, loopback, () => {
      const chosen = socket.address().port;
      socket.close(error => error ? reject(error) : accept(chosen));
    });
  });
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child) {
  if (!child || childExited(child)) return;
  let done;
  const ending = new Promise(accept => { done = accept; child.once("close", done); });
  try {
    child.kill();
    if (await Promise.race([ending.then(() => true), delay(6000, false, { ref: false })])) return;
    child.kill("SIGKILL");
    if (!(await Promise.race([ending.then(() => true), delay(3000, false, { ref: false })]))) throw new Error("Owned child did not exit");
  } finally {
    child.off("close", done);
  }
}

async function launch(config, releasePath, dataDir, port, token) {
  await reserveLoopback(port);
  const entry = join(releasePath, "server", "index.mjs");
  const child = spawn(process.execPath, [entry], {
    cwd: releasePath, env: serviceEnv(config, dataDir, port, token), windowsHide: true,
    stdio: "ignore"
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  try {
    const expires = performance.now() + 18_000;
    while (performance.now() < expires) {
      if (spawnError || childExited(child)) throw new Error("Service process could not start");
      const result = await fetch(`http://${loopback}:${port}/healthz`, {
        redirect: "error", signal: AbortSignal.timeout(1000)
      }).catch(() => null);
      if (result?.ok && !childExited(child)) {
        await result.body?.cancel();
        return child;
      }
      await result?.body?.cancel();
      await delay(220);
    }
    throw new Error("Service did not become healthy");
  } catch (error) {
    if (!spawnError) await stopChild(child);
    throw error;
  }
}

export async function supervise(config, signal) {
  const { root } = config;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "supervisor.lock");
  await mkdir(lock, { mode: 0o700 }).catch(() => {
    throw new Error("Cannot acquire deployment supervisor lock; another supervisor or operator inspection is needed");
  });
  const releases = join(root, "releases");
  const data = join(root, "data");
  const backups = join(root, "backups");
  const statePath = join(root, "active.json");
  let child;
  let state;
  const start = async release => { child = await launch(config, await prepareRelease(config, release, releases), data, config.port, config.token); };
  const stop = async () => { await stopChild(child); child = null; };
  const smoke = async release => {
    const releasePath = await prepareRelease(config, release, releases);
    const smokeDir = await mkdtemp(join(tmpdir(), "agent-workspace-smoke-"));
    let trial;
    try {
      trial = await launch({ ...config, publicOrigin: null, secureCookies: false }, releasePath, smokeDir, await reserveLoopback(), randomBytes(32).toString("hex"));
    } finally {
      await stopChild(trial);
      await rm(smokeDir, { recursive: true, force: true });
    }
  };
  const backup = async () => {
    if (!state.active) return;
    const copy = await mkdtemp(join(backups, `${state.active.sha.slice(0, 12)}-`));
    await cp(data, join(copy, "data"), { recursive: true, errorOnExist: true });
  };
  const persist = async next => {
    const nextPath = join(lock, "active.json");
    await writeFile(nextPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(nextPath, statePath);
  };
  try {
    await Promise.all([releases, data, backups].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    state = await releaseState(statePath);
    if (state.active) await start(state.active);
    let attempted;
    while (!signal.aborted) {
      try {
        const candidate = await exactMain(config);
        const key = candidate ? `${candidate.sha}:${candidate.runId}` : null;
        if (candidate && state.active?.sha !== candidate.sha && key !== attempted) {
          attempted = key;
          state = await transition(state, candidate, { start, stop, smoke, backup, persist });
          console.log(`Activated ${candidate.sha} from GitHub CI run ${candidate.runId}`);
        }
        if (state.active && (!child || childExited(child))) throw new Error("Active service exited; supervisor stopped for operator inspection");
      } catch (error) {
        if (state.active && (!child || childExited(child))) throw error;
        console.error("No release switch. Check verified main CI, Git access, and local readiness.");
      }
      await delay(240_000, null, { signal }).catch(error => { if (error.name !== "AbortError") throw error; });
    }
  } finally {
    await stop();
    await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  const signal = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => signal.abort());
  try { await supervise(deployedConfig(), signal.signal); }
  catch { console.error("Agent Workspace CD stopped. Check configuration, pending processes and deployment paths."); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
