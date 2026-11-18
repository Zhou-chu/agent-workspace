import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectGate, parseReceipt, renderGate} from '../scripts/sonar-gate.mjs';

const project = 'Zhou-chu_agent-workspace';
const receipt = `projectKey=${project}\nceTaskId=task-1\nceTaskUrl=https://untrusted.invalid/test\n`;

test('uses only the exact scanner task and analysis ID on the fixed Sonar HTTPS origin', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push([String(url), options]);
    return new Response(JSON.stringify(calls.length === 1
      ? {task: {id: 'task-1', componentKey: project, status: 'SUCCESS', analysisId: 'analysis-1'}}
      : {projectStatus: {status: 'ERROR', conditions: [
        {status: 'ERROR', metricKey: 'new_coverage', actualValue: '32.5', errorThreshold: '80'},
      ]}}));
  };
  const gate = await collectGate(receipt, 'synthetic-token', fakeFetch);
  assert.deepEqual(calls.map(([url]) => url), [
    'https://sonarcloud.io/api/ce/task?id=task-1',
    'https://sonarcloud.io/api/qualitygates/project_status?analysisId=analysis-1',
  ]);
  for (const [, options] of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
  }
  assert.match(renderGate(gate), /\*\*ERROR\*\*/);
  assert.match(renderGate(gate), /32\.5.*80/);
});

test('wrong task or project cannot generate a pinned result', async () => {
  assert.throws(() => parseReceipt(receipt.replace(project, 'wrong')), /receipt-scope/);
  let calls = 0;
  await assert.rejects(collectGate(receipt, 'synthetic', async () => {
    calls++;
    return new Response(JSON.stringify({
      task: {id: 'task-1', componentKey: 'wrong', status: 'SUCCESS', analysisId: 'good'},
    }));
  }), /task-scope/);
  assert.equal(calls, 1);
});

test('only finite numeric values and static known metric names reach the summary', () => {
  const summary = renderGate({status: 'ERROR', conditions: [
    {status: 'ERROR', metricKey: 'new_security_rating', actualValue: '5', errorThreshold: '1'},
    {status: 'ERROR', metricKey: 'new_coverage', actualValue: 'evil-value', errorThreshold: '80'},
    {status: 'ERROR', metricKey: 'evil-title', actualValue: '2', errorThreshold: '1'},
  ], privateDetails: 'evil-private'});
  assert.match(summary, /new_security_rating.*5.*1/);
  assert.doesNotMatch(summary, /evil|new_coverage/);
  assert.match(summary, /2 omitted/);
});
