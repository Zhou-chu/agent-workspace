import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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
  const gitExe = env.WORKSPACE_GIT_EXE || null;
  if (gitExe && !isAbsolute(gitExe)) throw new Error("WORKSPACE_GIT_EXE must be absolute");
  return { repository, workflow, root, port, token, gitExe, publicOrigin, secureCookies: Boolean(publicOrigin) || env.WORKSPACE_SECURE_COOKIES === "1" };
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

export function gitEnv(gitExe, env = process.env) {
  const inherited = Object.fromEntries(Object.entries(env).filter(([name]) => /^(?:systemroot|windir|temp|tmp|home|userprofile|localappdata|lang|lc_all)$/i.test(name)));
  const windowsRoot = env.SystemRoot ?? env.SYSTEMROOT;
  return {
    ...inherited,
    PATH: gitExe ? [dirname(gitExe), ...(windowsRoot ? [join(windowsRoot, "System32"), windowsRoot] : ["/usr/bin", "/bin"])].join(delimiter) : (env.PATH ?? env.Path ?? ""),
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
  };
}

const git = async (config, cwd, args) => (await execute(config.gitExe ?? "git", [
  "-c", "credential.helper=", "-c", "protocol.file.allow=never", ...args
], { cwd, env: gitEnv(config.gitExe), windowsHide: true, timeout: 90_000, maxBuffer: 512 * 1024 })).stdout.trim();

async function prepareRelease(config, release, releases, runGit) {
  validateRelease(release);
  const path = join(releases, release.sha);
  try {
    if (await runGit(config, path, ["rev-parse", "HEAD"]) === release.sha &&
        !(await runGit(config, path, ["status", "--porcelain", "--untracked-files=all"]))) return path;
    throw new Error("Existing release differs from verified commit; not overwriting");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = await mkdtemp(join(releases, ".incoming-"));
  try {
    await runGit(config, stage, ["init", "--quiet", "--template="]);
    await runGit(config, stage, ["fetch", "--no-tags", "--depth=1", `https://github.com/${config.repository}.git`, release.sha]);
    await runGit(config, stage, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    if (await runGit(config, stage, ["rev-parse", "HEAD"]) !== release.sha) throw new Error("Verified Git object and checkout differ");
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

function startChild(releasePath, entry, env) {
  const child = spawn(process.execPath, [join(releasePath, entry)], {
    cwd: releasePath, env, windowsHide: true, stdio: "ignore"
  });
  const service = { child, error: null };
  child.on("error", error => { service.error = error; });
  return service;
}

const healthy = services => Boolean(services?.length) && services.every(service => !service.error && !childExited(service.child));
const stopServices = services => Promise.all((services ?? []).map(service => service.error ? null : stopChild(service.child)));

async function waitForServices(services, probe) {
  const expires = performance.now() + 18_000;
  while (performance.now() < expires) {
    if (!healthy(services)) throw new Error("Service process could not start");
    if (await probe().catch(() => false) && healthy(services)) return;
    await delay(220);
  }
  throw new Error("Service did not become healthy");
}

function localFetch(origin, path, options) {
  return fetch(new URL(path, origin), { ...options, redirect:"error", signal:AbortSignal.timeout(1500) });
}

async function probeLive(origin, backend, token) {
  const page = await localFetch(origin, "/");
  const html = page.headers.get("content-type")?.startsWith("text/html");
  await page.body?.cancel();
  if (!page.ok || !html) return false;
  const api = await localFetch(origin, "/api/session", token ? { headers:{ Authorization:`Bearer ${token}` } } : {});
  const expectedApi = token
    ? api.ok && (await api.json()).imRealtime === true
    : api.status === 401 && api.headers.get("content-type")?.startsWith("application/json");
  if (!api.bodyUsed) await api.body?.cancel();
  if (!expectedApi) return false;
  const raw = await localFetch(backend, "/");
  await raw.body?.cancel();
  return raw.status === 404;
}

async function probeDisposableChat(origin, token) {
  const json = { "Content-Type":"application/json", Origin:origin };
  const login = await localFetch(origin, "/api/login", {method:"POST", headers:json, body:JSON.stringify({token})});
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  await login.body?.cancel();
  if (!login.ok || !cookie) throw new Error("Gateway could not log in to the disposable IM account");
  const wsUrl = new URL("/ws", origin);
  wsUrl.protocol = "ws:";
  // Node 24's native WebSocket uses Undici's options for local test headers.
  const ws = new WebSocket(wsUrl, { headers:{Cookie:cookie, Origin:origin} });
  let openTimer, frameTimer;
  function waitEvent(type, setTimer) {
    return new Promise((accept, reject) => {
      const failed = () => reject(new Error("Disposable IM WebSocket did not complete " + type));
      // A closed connection cannot pass readiness, even if logout cleans it up.
      ws.addEventListener("error", failed, {once:true});
      ws.addEventListener("close", failed, {once:true});
      ws.addEventListener(type, accept, {once:true});
      setTimer(setTimeout(failed, 2000));
    });
  }
  try {
    await waitEvent("open", timer => {openTimer=timer;});
    const frame = waitEvent("message", timer => {frameTimer=timer;});
    // Observe failure eagerly even if the HTTP request fails first.
    frame.catch(() => {});
    const sent = await localFetch(origin, "/api/rooms/general/messages", {
      method:"POST", headers:{...json,Cookie:cookie},
      body:JSON.stringify({body:"AgentChat disposable readiness",clientRequestId:"deployment-ready"}),
    });
    await sent.body?.cancel();
    if (sent.status!==201) throw new Error("Gateway could not send a disposable IM message");
    const event = JSON.parse((await frame).data);
    if (event.type!=="room.changed" || event.roomId!=="general") throw new Error("Gateway returned an unexpected disposable IM event");
  } finally {
    clearTimeout(openTimer);
    clearTimeout(frameTimer);
    ws.close();
  }
}

async function installPinnedRuntime(releasePath) {
  const npm = join(dirname(process.execPath), process.platform==="win32" ? "node_modules" : "../lib/node_modules", "npm", "bin", "npm-cli.js");
  await access(npm).catch(() => {throw new Error("The selected Node installation must include npm");});
  const configHome = await mkdtemp(join(tmpdir(), "agentchat-npm-config-"));
  try {
    // Suppress user/global npmrc even though the supported OS environment
    // includes a home. The verified release may not supply a project npmrc.
    const userconfig = join(configHome, "user.npmrc");
    const globalconfig = join(configHome, "global.npmrc");
    await Promise.all([userconfig,globalconfig].map(path => writeFile(path,"",{mode:0o600,flag:"wx"})));
    await execute(process.execPath,[
      npm,"ci","--omit=dev","--ignore-scripts","--no-audit","--no-fund",
      "--registry=https://registry.npmjs.org",`--userconfig=${userconfig}`,`--globalconfig=${globalconfig}`,
      `--cache=${join(configHome,"cache")}`,"--fetch-retries=1","--fetch-timeout=15000",
    ],{ cwd:releasePath, env:gitEnv(null), timeout:120_000, windowsHide:true, maxBuffer:256*1024 });
  } finally {
    await rm(configHome,{recursive:true,force:true});
  }
}

async function prepareRuntime(releasePath, installRuntime) {
  const present = async path => access(join(releasePath,path)).then(() => true, error => {
    if (error.code==="ENOENT") return false;
    throw error;
  });
  const [api,gateway,build] = await Promise.all(["server/api.mjs","frontend/gateway/index.mjs","frontend/build.mjs"].map(present));
  // Old releases may have a frontend build but neither modern entrypoint.
  if (!api && !gateway) return false;
  if (!api || !gateway || !build) throw new Error("Incomplete AgentChat split release");
  if (await present(".npmrc")) throw new Error("Split release cannot override npm configuration");
  await installRuntime(releasePath);
  await execute(process.execPath,[join(releasePath,"frontend","build.mjs")],{
    cwd:releasePath, env:gitEnv(null), windowsHide:true, timeout:15_000, maxBuffer:64*1024,
  });
  return true;
}

async function launch(config, releasePath, dataDir, port, token, modern, disposable = false) {
  await reserveLoopback(port);
  const origin = `http://${loopback}:${port}`;
  const backendPort = modern ? await reserveLoopback() : port;
  if (modern && backendPort === port) throw new Error("Could not reserve a distinct backend port");
  const backend = `http://${loopback}:${backendPort}`;
  const services = [];
  try {
    services.push(startChild(releasePath,modern?"server/api.mjs":"server/index.mjs",serviceEnv(config,dataDir,backendPort,token)));
    if (modern) {
      services.push(startChild(releasePath,"frontend/gateway/index.mjs",{
        ...gitEnv(null), AGENTCHAT_FRONTEND_HOST:loopback, AGENTCHAT_FRONTEND_PORT:String(port), AGENTCHAT_BACKEND_ORIGIN:backend,
      }));
      await waitForServices(services,() => probeLive(origin,backend,disposable ? token : null));
      if (disposable) await probeDisposableChat(origin,token);
    } else {
      await waitForServices(services,async () => {
        const response=await localFetch(origin,"/healthz");
        await response.body?.cancel();
        return response.ok;
      });
    }
    return services;
  } catch (error) {
    await stopServices(services);
    throw error;
  }
}

// Keep real process and file custody in this controller; allow local tests to
// stand in for GitHub, Git command transport, and the four-minute poll wait.
export async function supervise(config, signal, { fetcher = fetch, runGit = git, pause = delay, logger = console, installRuntime = installPinnedRuntime } = {}) {
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
  let services;
  let state;
  const prepared = new Map();
  async function ready(release) {
    const path=await prepareRelease(config,release,releases,runGit);
    if (!prepared.has(path)) prepared.set(path,await prepareRuntime(path,installRuntime));
    return { path, modern:prepared.get(path) };
  }
  const start = async release => {
    const {path,modern}=await ready(release);
    services=await launch(config,path,data,config.port,config.token,modern);
  };
  const stop = async () => { await stopServices(services); services=null; };
  const smoke = async release => {
    const {path,modern}=await ready(release);
    const smokeDir = await mkdtemp(join(tmpdir(), "agent-workspace-smoke-"));
    let trial;
    try {
      trial = await launch({ ...config, publicOrigin: null, secureCookies: false }, path, smokeDir, await reserveLoopback(), randomBytes(32).toString("hex"),modern,true);
    } finally {
      await stopServices(trial);
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
        const candidate = await exactMain(config, fetcher);
        const key = candidate ? `${candidate.sha}:${candidate.runId}` : null;
        if (candidate && state.active?.sha !== candidate.sha && key !== attempted) {
          attempted = key;
          state = await transition(state, candidate, { start, stop, smoke, backup, persist });
          logger.log(`Activated ${candidate.sha} from GitHub CI run ${candidate.runId}`);
        }
        if (state.active && !healthy(services)) throw new Error("Active service exited; supervisor stopped for operator inspection");
      } catch (error) {
        if (state.active && !healthy(services)) throw error;
        logger.error("No release switch. Check verified main CI, Git access, and local readiness.");
      }
      await pause(240_000, null, { signal }).catch(error => { if (error.name !== "AbortError") throw error; });
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
