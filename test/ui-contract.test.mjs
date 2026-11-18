import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatPayload, mergeMessages, chooseRoom } from '../web/chat-model.mjs';

test('ordinary text and ordinary replies cannot implicitly wake an agent', () => {
  assert.deepEqual(createChatPayload({ body: ' @agent ?', replyTo: 'old' }, 'id'), {
    clientRequestId: 'id', body: '@agent ?', mentions: [], replyTo: 'old',
  });
});
test('only explicitly selected actor IDs become de-duplicated mentions', () => {
  assert.deepEqual(createChatPayload({ body: 'go', mentions: new Set(['a1', 'a2', 'a1']) }, 'id'), {
    clientRequestId: 'id', body: 'go', mentions: ['a1', 'a2'],
  });
  assert.throws(() => createChatPayload({ body: ' ' }, 'id'), /消息/);
});
test('newly read messages are merged idempotently without disturbing order', () => {
  const a = { id: 'a', body: 'once' };
  const b = { id: 'b', body: 'twice' };
  assert.deepEqual(mergeMessages([a], [a, b]), [a, b]);
});
test('stale mobile room IDs fall back to an authorized available room', () => {
  const rooms = [{ id: 'default' }, { id: 'second' }];
  assert.equal(chooseRoom(rooms, 'second'), 'second');
  assert.equal(chooseRoom(rooms, 'forbidden'), 'default');
  assert.equal(chooseRoom([], 'forbidden'), null);
});
