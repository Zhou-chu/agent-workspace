/** Collect only the Quality Gate linked to the scanner receipt for this run. */
import {appendFile, readFile} from 'node:fs/promises';

const project = 'Zhou-chu_agent-workspace';
const origin = 'https://sonarcloud.io';
const statuses = new Set(['OK', 'WARN', 'ERROR', 'NONE']);
const comparators = new Set(['GT', 'LT', 'EQ', 'NE']);
const metrics = new Set([
  'coverage', 'duplicated_lines_density', 'reliability_rating',
  'security_rating', 'security_review_rating', 'security_hotspots_reviewed',
  'sqale_rating', 'violations', 'new_coverage', 'new_duplicated_lines_density',
  'new_reliability_rating', 'new_security_rating', 'new_maintainability_rating',
  'new_security_hotspots_reviewed', 'new_security_review_rating', 'new_violations',
  'new_software_quality_reliability_rating', 'new_software_quality_security_rating',
  'new_software_quality_maintainability_rating',
]);
const boundedId = /^[A-Za-z0-9_-]{1,100}$/;
const decimal = /^-?\d{1,12}(?:\.\d{1,10})?$/;

class GateError extends Error {}

export function parseReceipt(receipt) {
  if (typeof receipt !== 'string' || receipt.length > 8192) throw new GateError('invalid-receipt');
  const known = new Map();
  for (const line of receipt.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split < 0) continue;
    const field = line.slice(0, split);
    if (field !== 'projectKey' && field !== 'ceTaskId') continue;
    if (known.has(field)) throw new GateError('invalid-receipt');
    known.set(field, line.slice(split + 1));
  }
  if (known.get('projectKey') !== project) throw new GateError('receipt-scope');
  const id = known.get('ceTaskId');
  if (!id || !boundedId.test(id)) throw new GateError('invalid-task-id');
  return id;
}

async function getJson(url, token, read) {
  try {
    const response = await read(url, {
      method: 'GET',
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new GateError(`sonar-http-${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof GateError) throw error;
    // No raw network errors or service response bodies in public logs.
    throw new GateError('sonar-api-unavailable');
  }
}

export async function collectGate(receipt, token, read = fetch) {
  const taskId = parseReceipt(receipt);
  if (!token) throw new GateError('sonar-token-unavailable');
  const taskUrl = new URL('/api/ce/task', origin);
  taskUrl.searchParams.set('id', taskId);
  const task = (await getJson(taskUrl, token, read))?.task;
  if (task?.id !== taskId || task?.componentKey !== project) throw new GateError('task-scope');
  if (task.status !== 'SUCCESS') throw new GateError('compute-task-not-successful');
  if (typeof task.analysisId !== 'string' || !boundedId.test(task.analysisId)) {
    throw new GateError('invalid-analysis-id');
  }
  const gateUrl = new URL('/api/qualitygates/project_status', origin);
  gateUrl.searchParams.set('analysisId', task.analysisId);
  const gate = (await getJson(gateUrl, token, read))?.projectStatus;
  if (!statuses.has(gate?.status) || !Array.isArray(gate.conditions)) throw new GateError('invalid-gate');
  return gate;
}

export function renderGate(gate) {
  const lines = ['### SonarQube Cloud Quality Gate', '', `Status: **${statuses.has(gate.status) ? gate.status : 'unavailable'}** (scan-specific).`, ''];
  const cells = (value) => typeof value === 'string' && decimal.test(value) && Number.isFinite(Number(value));
  const rows = gate.conditions.filter((item) =>
    item && metrics.has(item.metricKey) && statuses.has(item.status) && cells(item.actualValue) && cells(item.errorThreshold),
  ).slice(0, 50);
  if (rows.length > 0) {
    lines.push('| Metric | Status | Actual | Failure threshold |', '| --- | --- | ---: | --- |');
    for (const row of rows) {
      const comparator = comparators.has(row.comparator) ? `${row.comparator} ` : '';
      lines.push(`| \`${row.metricKey}\` | ${row.status} | ${row.actualValue} | ${comparator}${row.errorThreshold} |`);
    }
  }
  const omitted = gate.conditions.length - rows.length;
  if (omitted) lines.push('', `${omitted} omitted (unknown or incomplete metric data).`);
  if (gate.status === 'ERROR' && !rows.some((row) => row.status === 'ERROR')) {
    lines.push('', 'Failed condition values were not available in the permitted summary fields.');
  }
  return lines.join('\n') + '\n';
}

async function writeSummary() {
  let summary;
  try {
    const receipt = await readFile(process.env.SONAR_RECEIPT, 'utf8');
    summary = renderGate(await collectGate(receipt, process.env.SONAR_TOKEN));
  } catch (error) {
    const code = error instanceof GateError ? error.message : 'scanner-receipt-unavailable';
    summary = `### SonarQube Cloud Quality Gate\n\nDetails unavailable: \`${code}\`. The scanner result is unchanged.\n`;
    process.exitCode = 1;
  }
  // The connector can read job logs even where the GitHub summary endpoint is unavailable.
  process.stdout.write(summary);
  try {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch {
    // Keep this fixed and avoid echoing action-local paths or exception strings.
    console.error('Sonar Quality Gate summary could not be written.');
    process.exitCode = 1;
  }
}

if (import.meta.main) await writeSummary();
