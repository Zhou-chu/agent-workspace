import test from 'node:test';
import assert from 'node:assert/strict';
import { hostStatus, checkStatus, mayRequestCheck, nextCheckRequestId } from '../web/host-model.mjs';

test('device status never conflates registration with verified contact', () => {
  assert.equal(hostStatus('never_seen'), '尚未连接');
  assert.equal(hostStatus('revoked'), '已撤销');
  assert.equal(hostStatus('offline'), '离线');
  assert.equal(hostStatus('unexpected'), '未知');
  for (const s of ['never_seen', 'revoked', 'offline', 'unexpected']) assert.equal(mayRequestCheck(s), false);
  assert.equal(mayRequestCheck('online'), true);
});

test('status check differentiates queuing, host claim, receipt and uncertainty', () => {
  assert.equal(checkStatus('pending'), '等待设备领取');
  assert.equal(checkStatus('claimed'), '已领取，等待回执');
  assert.equal(checkStatus('completed'), '已收到回执');
  assert.equal(checkStatus('uncertain'), '结果待核对');
  assert.equal(checkStatus('expired'), '已过期');
  assert.equal(checkStatus('cancelled'), '已取消');
});

test('unacknowledged requests reuse the same id until success', () => {
  assert.equal(nextCheckRequestId(undefined, () => 'first'), 'first');
  assert.equal(nextCheckRequestId('first', () => { throw new Error('must reuse'); }), 'first');
});
