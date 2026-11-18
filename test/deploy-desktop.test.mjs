import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter, dirname, join, resolve } from "node:path";
import { exactMain, deployedConfig, gitEnv, serviceEnv, transition } from "../deploy/desktop.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "owner/example";
const run = {
  id: 401,
  event: "push", head_branch: "main", head_sha: SHA,
  head_repository: { full_name: REPO },
  status: "completed", conclusion: "success"
};

function client({runs = [run], sha = SHA} = {}) {
  const requests = [];
  return {
    requests,
    fetcher: async (url, options) => {
      assert.equal(options.redirect, "error");
      requests.push(new URL(url));
      const result = requests.length === 1 ? { object: { sha, type: "commit" } } : { workflow_runs: runs };
      return Response.json(result);
    }
  };
}

test("selects only the latest successful exact main push and pins URLs", async () => {
  const { requests, fetcher } = client({ runs: [{ ...run, id: 400, conclusion: "failure" }, run] });
  assert.deepEqual(await exactMain({ repository: REPO, workflow: "ci.yml" }, fetcher), { sha: SHA, runId: 401 });
  assert.deepEqual(requests.map((x) => x.hostname), ["api.github.com", "api.github.com"]);
  assert.equal(requests[1].searchParams.get("head_sha"), SHA);
});

test("rejects PR, fork, stale SHA, or failed/running/null latest attempts", async () => {
  const invalid = [
    { ...run, event: "pull_request" },
    { ...run, head_repository: { full_name: "other/example" } },
    { ...run, head_sha: OTHER },
    { ...run, status: "queued", conclusion: null },
    { ...run, conclusion: "failure" },
  ];
  for (const changed of invalid.slice(0,3)) {
    assert.equal(await exactMain({ repository: REPO, workflow: "ci.yml" }, client({ runs: [changed] }).fetcher), null);
  }
  for (const changed of invalid.slice(3)) {
    assert.equal(await exactMain({ repository: REPO, workflow: "ci.yml" }, client({ runs: [run, { ...changed, id: 402 }] }).fetcher), null);
  }
  await assert.rejects(exactMain({ repository: REPO, workflow: "ci.yml" }, client({sha: "../invalid"}).fetcher), /commit/);
  await assert.rejects(exactMain({ repository: REPO, workflow: "ci.yml" }, async () => new Response("", {status: 403})), /403/);
});

test("deployment requires a strong pre-provisioned token and fixed loopback serve", () => {
  const good = { WORKSPACE_REPOSITORY: REPO, WORKSPACE_TOKEN: "x".repeat(48), WORKSPACE_CD_ROOT: "/owned", WORKSPACE_PORT: "4319" };
  const config = deployedConfig(good);
  assert.equal(config.port, 4319);
  assert.equal(serviceEnv(config, "virtual", 4320, "example").WORKSPACE_HOST, "127.0.0.1");
  assert.equal(serviceEnv(config, "virtual", 4320, "example").WORKSPACE_TOKEN, "example");
  assert.throws(() => deployedConfig({ ...good, WORKSPACE_TOKEN: "" }), /WORKSPACE_TOKEN/);
  assert.throws(() => deployedConfig({ ...good, WORKSPACE_REPOSITORY: "../example" }), /repository/i);
  assert.throws(() => deployedConfig({ ...good, WORKSPACE_CI_WORKFLOW: "../other.yml" }), /workflow/i);
  assert.throws(() => deployedConfig({ ...good, WORKSPACE_PORT: "0" }), /port/i);
});

test("HTTPS settings use the server's plural secure-cookies contract", () => {
  const good = { WORKSPACE_REPOSITORY: REPO, WORKSPACE_TOKEN: "x".repeat(48) };
  const local = serviceEnv(deployedConfig(good), "data", 4319, "test");
  assert.equal(local.WORKSPACE_SECURE_COOKIES, "0");
  assert.equal(local.WORKSPACE_PUBLIC_ORIGIN, undefined);
  const config = deployedConfig({ ...good, WORKSPACE_PUBLIC_ORIGIN: "https://workspace.example.test", WORKSPACE_SECURE_COOKIES: "1" });
  const https = serviceEnv(config, "data", 4319, "test");
  assert.equal(https.WORKSPACE_PUBLIC_ORIGIN, "https://workspace.example.test");
  assert.equal(https.WORKSPACE_SECURE_COOKIES, "1");
  assert.equal(https.WORKSPACE_HOST, "127.0.0.1");
  assert.throws(() => deployedConfig({ ...good, WORKSPACE_PUBLIC_ORIGIN: "http://workspace.example.test" }), /HTTPS/);
  assert.throws(() => deployedConfig({ ...good, WORKSPACE_PUBLIC_ORIGIN: "https://workspace.example.test/other" }), /HTTPS/);
});

test("pinned Git subprocess has a restricted PATH and never receives application credentials", () => {
  const gitExe = resolve("reviewed", "Git", "git.exe");
  const system = resolve("Windows");
  const env = gitEnv(gitExe, { SystemRoot: system, PATH: "unexpected", WORKSPACE_TOKEN: "not for git", GH_TOKEN: "not for git", GIT_EXEC_PATH: "not for git" });
  assert.deepEqual(env.PATH.split(delimiter), [dirname(gitExe), join(system, "System32"), system]);
  for (const name of ["WORKSPACE_TOKEN", "GH_TOKEN", "GIT_EXEC_PATH"]) assert.equal(env[name], undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.throws(() => deployedConfig({ WORKSPACE_REPOSITORY: REPO, WORKSPACE_TOKEN: "x".repeat(48), WORKSPACE_GIT_EXE: "relative-git" }), /absolute/);
});

function procedure({ broken = null } = {}) {
  const calls = [];
  const state = { active: { sha: OTHER, runId: 10 } };
  const ops = Object.fromEntries(["smoke", "stop", "backup", "start", "persist"].map(key =>
    [key, async arg => {
      calls.push([key, arg]);
      if (broken && broken(key, arg)) throw new Error("fixture failure");
    }]
  ));
  return { calls, state, ops };
}

test("candidate smoke precedes stopping; production uses backed-up data with exact release", async () => {
  const { calls, state, ops } = procedure();
  const candidate = { sha: SHA, runId: 401 };
  const result = await transition(state, candidate, ops);
  assert.deepEqual(calls.map(([key]) => key), ["smoke", "stop", "backup", "start", "persist"]);
  assert.deepEqual(result.active, candidate);
  assert.deepEqual(result.previous, state.active);
});

test("failed smoke leaves existing instance alone; failed activation starts last version", async () => {
  const candidate = { sha: SHA, runId: 401 };
  let x = procedure({ broken: k => k === "smoke" });
  await assert.rejects(transition(x.state, candidate, x.ops), /fixture failure/);
  assert.deepEqual(x.calls.map(([key]) => key), ["smoke"]);
  x = procedure({ broken: (k, val) => k === "start" && val.sha === SHA });
  await assert.rejects(transition(x.state, candidate, x.ops), /fixture failure/);
  assert.deepEqual(x.calls.map(([key]) => key), ["smoke", "stop", "backup", "start", "stop", "start"]);
  assert.deepEqual(x.calls.at(-1)[1], x.state.active);
});

test("no-op preserves active runtime and persisted state", async () => {
  const { calls, state, ops } = procedure();
  assert.equal(await transition(state, state.active, ops), state);
  assert.deepEqual(calls, []);
});
