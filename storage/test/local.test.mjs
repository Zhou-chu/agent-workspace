import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as storage from '../index.mjs';

async function open(t, maxBytes) {
  const temp = await mkdtemp(join(tmpdir(), 'agentchat-objects-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, 'objects');
  assert.equal(typeof storage.createLocalStorage, 'function', 'must export the local adapter factory');
  return { directory, objects: storage.createLocalStorage({ directory, maxBytes }) };
}

test('stores the original bytes across adapter restart and deletes only the intended object', async t => {
  const { directory, objects } = await open(t);
  const first = randomUUID();
  const second = 'a'.repeat(64);
  const bytes = new Uint8Array([0, 42, 255]);
  assert.equal(await objects.get(first), null);
  assert.equal(await objects.delete(first), false);
  assert.deepEqual(await objects.put(first, bytes), { size: 3 });
  bytes[1] = 7;
  await objects.put(second, new Uint8Array([8]));
  const reopened = storage.createLocalStorage({ directory });
  assert.deepEqual(await reopened.get(first), Buffer.from([0, 42, 255]));
  assert.equal(await reopened.delete(first), true);
  assert.equal(await objects.get(first), null);
  assert.deepEqual(await reopened.get(second), Buffer.from([8]));
});

test('concurrent creation commits exactly one complete immutable object', async t => {
  const { directory, objects } = await open(t);
  const key = randomUUID();
  const values = [Buffer.alloc(20_000, 7), Buffer.alloc(22_000, 11)];
  const attempts = await Promise.allSettled(values.map(value => objects.put(key, value)));
  const accepted = attempts.findIndex(row => row.status === 'fulfilled');
  assert.ok(accepted >= 0);
  assert.equal(attempts[1 - accepted].status, 'rejected');
  assert.equal(attempts[1 - accepted].reason.code, 'EEXIST');
  assert.deepEqual(await objects.get(key), values[accepted]);
  assert.deepEqual(await readdir(directory), [key]);
});

test('enforces bounded byte-oriented payloads and accepts only opaque keys', async t => {
  const { directory, objects } = await open(t, 4);
  const key = randomUUID();
  assert.equal(storage.MAX_OBJECT_BYTES, 10 * 1024 * 1024);
  for (const op of [() => objects.put('not-an-object-id', Buffer.from([1])),
    () => objects.get('report.pdf'), () => objects.delete('friendly-name'),
    () => objects.put(key, 'text')]) {
    await assert.rejects(op, TypeError);
  }
  await assert.rejects(objects.put(key, Buffer.alloc(5)), { code: 'OBJECT_TOO_LARGE' });
  assert.deepEqual(await objects.put(key, Buffer.alloc(4)), { size: 4 });
  const smallerReader = storage.createLocalStorage({ directory, maxBytes: 3 });
  await assert.rejects(smallerReader.get(key), { code: 'OBJECT_TOO_LARGE' });
});
