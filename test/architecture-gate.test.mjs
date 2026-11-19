import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = fileURLToPath(new URL('../.dependency-cruiser.cjs', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', import.meta.url));

function cruiseFixture(t, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'aw-module-graph-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
  for (const [file, content] of Object.entries(files)) {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const { status, stdout, stderr, error } = spawnSync(process.execPath,
    [cli, '--config', config, ...new Set(Object.keys(files).filter(file => !file.startsWith('node_modules/')).map(file => file.split('/')[0]))],
    { cwd, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(error);
  assert.ok(stdout, stderr);
  return { status, violations: [...stdout.matchAll(/\berror ([\w-]+):/g)].map(([, name]) => name) };
}

test('permits same-runtime modules and Node built-ins outside the browser', t => {
  const result = cruiseFixture(t, {
    'frontend/public/app.mjs': "import './view.mjs';",
    'frontend/public/view.mjs': 'export const view = 1;',
    'server/index.mjs': "import 'node:sqlite';",
  });
  assert.deepEqual(result, { status: 0, violations: [] });
});

test('blocks cross-runtime edges, browser Node imports, and missing modules', t => {
  const { status, violations } = cruiseFixture(t, {
    'frontend/public/app.mjs': "import '../../server/entry.mjs'; import 'node:crypto';",
    'server/entry.mjs': "import '../connector/adapter.mjs';",
    'connector/adapter.mjs': "import '../deploy/local.mjs';",
    'deploy/local.mjs': "import './missing.mjs';",
  });
  assert.ok(status > 0);
  assert.deepEqual(violations.sort(),
    ['browser-no-node', 'connector-runtime-boundary', 'no-unresolved', 'server-runtime-boundary', 'web-runtime-boundary']);
});

test('blocks cycles entirely within a runtime', t => {
  const { status, violations } = cruiseFixture(t, {
    'server/a.mjs': "import './b.mjs';",
    'server/b.mjs': "import './a.mjs';",
  });
  assert.ok(status > 0);
  assert.ok(violations.length);
  assert.ok(violations.every(rule => rule === 'no-cycles'));
});

test('blocks third-party modules from production runtimes', t => {
  const { status, violations } = cruiseFixture(t, {
    'connector/run.mjs': "import 'sample-fixture-dependency';",
    'node_modules/sample-fixture-dependency/package.json': '{"main":"index.js"}',
    'node_modules/sample-fixture-dependency/index.js': 'module.exports = 1;',
  });
  assert.ok(status > 0);
  assert.deepEqual(violations, ['no-runtime-packages']);
});
