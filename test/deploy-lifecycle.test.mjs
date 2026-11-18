import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { exactMain, supervise } from '../deploy/desktop.mjs';

const OLD = "b".repeat(40);
const NEW = "c".repeat(40);
const REPO = "owner/workspace";
const current = (sha, id = 401) => ({ sha, runId: id });
const healthProgram = `import { createServer } from 'node:http';
import { basename } from 'node:path';
if (process.env.BROKEN_FIXTURE !== undefined) process.exit(70);
createServer((req, res) => {
  if (req.url !== '/healthz') { res.writeHead(404).end(); return; }
  res.end(JSON.stringify({ ok: true, production: basename(process.env.WORKSPACE_DATA_DIR) === 'data' }));
}).listen(Number(process.env.WORKSPACE_PORT), process.env.WORKSPACE_HOST);`;

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function makeHost(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-cd-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { root, port: await freePort(), token: 'fixture-only-owner-token-do-not-use', repository: REPO, workflow: 'ci.yml' };
  const controller = new AbortController();
  const commands = [], errors = [], logs = [];
  const options = {
    logger: { log: message => logs.push(message), error: message => errors.push(message) },
    async pause() { controller.abort(); },
    async fetcher(url) {
      const target = new URL(url);
      assert.equal(target.hostname, 'api.github.com');
      if (target.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: NEW } });
      return Response.json({ workflow_runs: [{ id: 401, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push', head_sha: NEW, head_repository: {full_name: REPO} }] });
    },
    async runGit(_config, directory, [action, ...args]) {
      commands.push([action, ...args]);
      const head = join(directory, '.fixture-head');
      if (action === 'init') return '';
      if (action === 'fetch') { await writeFile(head, args.at(-1)); return ''; }
      if (action === 'checkout') { await writeRelease(directory, await readFile(head, 'utf8')); return ''; }
      if (action === 'rev-parse') return readFile(head, 'utf8');
      if (action === 'status') return '';
      throw Error('unexpected Git action');
    }
  };
  const inspect = async () => JSON.parse(await readFile(join(root, 'active.json'), 'utf8'));
  const health = async () => (await fetch(`http://127.0.0.1:${config.port}/healthz`, {signal: AbortSignal.timeout(2000)})).json();
  return { root, config, controller, options, commands, logs, errors, inspect, health };
}

async function writeRelease(directory, sha, source = healthProgram) {
  await mkdir(join(directory, 'server'), {recursive: true});
  await writeFile(join(directory, '.fixture-head'), sha);
  await writeFile(join(directory, 'server', 'index.mjs'), source);
}

async function seedActive(root) {
  const active = current(OLD, 400);
  await writeRelease(join(root, 'releases', OLD), OLD);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'original.txt'), 'keep and back up');
  await writeFile(join(root, 'active.json'), JSON.stringify({ active, previous: null }));
  return active;
}

test('tests real loopback readiness and process cleanup before and after exact release activation', async t => {
  const host = await makeHost(t);
  host.options.pause = async () => {
    // Store plain observed facts inside the loop; assert outside the supervisor.
    host.first = await host.health();
    host.active = await host.inspect();
    host.controller.abort();
  };
  await supervise(host.config, host.controller.signal, host.options);
  assert.deepEqual(host.first, {ok:true, production:true});
  assert.deepEqual(host.active, {active: current(NEW), previous: null});
  assert.deepEqual(host.commands.find(c => c[0] === 'fetch'), ['fetch','--no-tags','--depth=1', 'https://github.com/owner/workspace.git', NEW]);
  assert.equal(host.logs.length, 1);
  assert.deepEqual(host.errors, []);
  assert.ok(!(await readdir(host.root)).includes('supervisor.lock'));
  await assert.rejects(host.health());
});

test('existing supervisor lock is preserved without API or Git work; corrupt persisted state fails closed', async t => {
  const host = await makeHost(t);
  await mkdir(join(host.root, 'supervisor.lock'));
  await assert.rejects(supervise(host.config, host.controller.signal, host.options), /cannot acquire/i);
  assert.deepEqual(host.commands, []);
  assert.ok((await readdir(host.root)).includes('supervisor.lock'));
  await rm(join(host.root, 'supervisor.lock'), {recursive: true});
  const state = join(host.root, 'active.json');
  const original = '{"active":{"sha":"../invalid","runId":0}}';
  await writeFile(state, original);
  await assert.rejects(supervise(host.config, host.controller.signal, host.options), /Invalid release state/);
  assert.equal(await readFile(state, 'utf8'), original);
  assert.ok(!(await readdir(host.root)).includes('supervisor.lock'));
});

test('failed isolated smoke never touches the prior live release and is not retried for the same CI run', async t => {
  const host = await makeHost(t);
  const prior = await seedActive(host.root);
  await writeRelease(join(host.root, 'releases', NEW), NEW, 'process.exit(70);');
  let polls = 0;
  host.options.pause = async () => { host.priorCheck = await host.health(); if (++polls === 2) host.controller.abort(); };
  await supervise(host.config, host.controller.signal, host.options);
  assert.deepEqual(host.priorCheck, {ok:true, production:true});
  assert.deepEqual(await host.inspect(), {active: prior, previous: null});
  assert.deepEqual(await readdir(join(host.root, 'backups')), []);
  assert.equal(host.errors.length, 1);
  assert.deepEqual(host.logs, []);
  assert.equal(host.commands.filter(c => c[0] === 'status').length, 2); // only old startup and one candidate check
});

test('failed production activation restarts previous process, preserves state and backs up original data', async t => {
  const host = await makeHost(t);
  const prior = await seedActive(host.root);
  const failOnlyProduction = healthProgram.replace(
    'if (process.env.BROKEN_FIXTURE !== undefined)',
    "if (basename(process.env.WORKSPACE_DATA_DIR) === 'data')"
  );
  await writeRelease(join(host.root, 'releases', NEW), NEW, failOnlyProduction);
  host.options.pause = async () => { host.restored = await host.health(); host.controller.abort(); };
  await supervise(host.config, host.controller.signal, host.options);
  assert.deepEqual(host.restored, {ok:true, production:true});
  assert.deepEqual(await host.inspect(), {active: prior, previous:null});
  const [name] = await readdir(join(host.root, 'backups'));
  assert.ok(name.startsWith(OLD.slice(0,12)));
  assert.equal(await readFile(join(host.root, 'backups', name, 'data', 'original.txt'), 'utf8'), 'keep and back up');
  assert.equal(await readFile(join(host.root, 'data', 'original.txt'), 'utf8'), 'keep and back up');
  assert.equal(host.errors.length, 1);
});

test('unexpected response types from public CI fail closed and prevent candidate selection', async () => {
  const config = {repository: REPO, workflow:'ci.yml'};
  let first = true;
  await assert.rejects(exactMain(config, async () => {
    if (first) { first = false; return Response.json({ object: {type:'commit', sha: NEW} }); }
    return Response.json({ error:'malformed' });
  }), /Invalid CI result/);
});
