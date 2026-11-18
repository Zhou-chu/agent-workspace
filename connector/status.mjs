import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

export const connectorVersion = '0.1.0';
const supportedPlatforms = new Set(['win32','darwin','linux','freebsd','openbsd','android','aix','sunos']);
const stableId = /^[A-Za-z0-9_-]{1,100}$/;
const maxResponseBytes = 64 * 1024;

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Use an absolute HTTPS or loopback HTTP origin.'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (typeof value !== 'string' || !/^(?:https|http):\/\//.test(value) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new TypeError('Use an absolute HTTPS or loopback HTTP origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

class ConnectorError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

async function boundedJson(response) {
  if (!response.body) throw new ConnectorError('Coordinator returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let bytes = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new ConnectorError('Coordinator response exceeds the size limit.');
      }
      text += decoder.decode(value, {stream:true});
    }
    const value = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch(error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('Coordinator returned an unreadable response.', true);
  } finally { reader.releaseLock(); }
}

function openJournal(dbPath, binding) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), {recursive:true,mode:0o700});
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS connector_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        binding TEXT NOT NULL, request_id TEXT, receipt TEXT
      );
    `);
    db.prepare('INSERT OR IGNORE INTO connector_state(singleton,binding) VALUES(1,?)').run(binding);
    if (db.prepare('SELECT binding FROM connector_state WHERE singleton=1').get()?.binding !== binding) {
      throw new ConnectorError('The journal is already bound to another origin or host credential.');
    }
    return db;
  } catch(error) {
    db.close();
    throw error;
  }
}

export function createConnector({baseUrl,token,dbPath=':memory:',fetchImpl=globalThis.fetch,requestTimeoutMs=5000} = {}) {
  const origin = normalizeOrigin(baseUrl);
  if (typeof token !== 'string' || !/^aw_host_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError('A dedicated host token is required.');
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
    throw new TypeError('Request timeout must range from 1 to 30000 ms.');
  }
  const binding = createHash('sha256').update(origin+'\0'+token).digest('hex');
  const db = openJournal(dbPath,binding);
  const get = db.prepare('SELECT request_id,receipt FROM connector_state WHERE singleton=1');
  const begin = db.prepare('UPDATE connector_state SET request_id=? WHERE singleton=1 AND request_id IS NULL');
  const save = db.prepare('UPDATE connector_state SET receipt=? WHERE singleton=1 AND request_id=? AND receipt IS NULL');
  const clear = db.prepare('UPDATE connector_state SET request_id=NULL,receipt=NULL WHERE singleton=1 AND request_id=?');
  let running = false;

  async function post(path,body,signal) {
    let response;
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    try {
      response = await fetchImpl(new URL(path,origin).href, {
        method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify(body),
      });
    } catch {
      throw new ConnectorError('Coordinator transport interrupted.', true);
    }
    if (!response.ok || (response.url && new URL(response.url).origin !== origin)) {
      await response.body?.cancel();
      throw new ConnectorError(
        `Coordinator rejected the host request (HTTP ${response.status}).`,
        [408,429,502,503,504].includes(response.status),
      );
    }
    return boundedJson(response);
  }

  async function acknowledge(requestId, receipt, signal) {
    const {check} = await post('/api/host/status-checks/'+encodeURIComponent(receipt.id)+'/ack',
      {receiptId:receipt.receiptId,result:receipt.result},signal);
    if (check?.id !== receipt.id || check.status !== 'completed') {
      throw new ConnectorError('Coordinator did not confirm this exact receipt.');
    }
    clear.run(requestId);
    return 'completed';
  }

  async function tick(signal) {
    if (running) throw new ConnectorError('Only one poll may be running per connector.');
    running = true;
    try {
      const {host} = await post('/api/host/heartbeat',{},signal);
      if (typeof host?.id !== 'string') throw new ConnectorError('Coordinator did not identify the authenticated host.');
      begin.run(randomUUID());
      const state = get.get();
      if (state.receipt) return await acknowledge(state.request_id,JSON.parse(state.receipt),signal);

      const {check} = await post('/api/host/status-checks/claim',{requestId:state.request_id},signal);
      if (check === null) {
        clear.run(state.request_id);
        return 'idle';
      }
      if (check?.action !== 'report_status' || !stableId.test(check.id ?? '') ||
          !stableId.test(check.receiptId ?? '') || check.hostId !== host.id ||
          !['claimed','uncertain','completed'].includes(check.status)) {
        throw new ConnectorError('Coordinator returned an unsupported host status check.');
      }
      if (check.status === 'completed') {
        clear.run(state.request_id);
        return 'completed';
      }
      const platform = supportedPlatforms.has(process.platform) ? process.platform : 'other';
      const receipt = {id:check.id,receiptId:check.receiptId,result:{platform,connectorVersion}};
      if (save.run(JSON.stringify(receipt),state.request_id).changes !== 1) {
        throw new ConnectorError('The host journal changed while polling; use one connector per journal.');
      }
      return await acknowledge(state.request_id,receipt,signal);
    } finally { running = false; }
  }

  return {tick,close:()=>db.close()};
}

async function main() {
  const stateDir = process.env.WORKSPACE_CONNECTOR_STATE_DIR;
  if (!stateDir) throw new TypeError('Set WORKSPACE_CONNECTOR_STATE_DIR to a private, persistent directory.');
  const interval = Number(process.env.WORKSPACE_CONNECTOR_POLL_MS ?? 10_000);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 30_000) {
    throw new TypeError('WORKSPACE_CONNECTOR_POLL_MS must range from 1000 to 30000 ms.');
  }
  const ctrl = new AbortController();
  for (const name of ['SIGINT','SIGTERM']) process.once(name,()=>ctrl.abort());
  const c = createConnector({
    baseUrl:process.env.WORKSPACE_CONNECTOR_ORIGIN,
    token:process.env.WORKSPACE_CONNECTOR_TOKEN,
    dbPath:resolve(stateDir,'status.sqlite'),
  });
  try {
    let failures = 0;
    while (!ctrl.signal.aborted) {
      try {
        await c.tick(ctrl.signal);
        failures = 0;
      } catch(error) {
        if (ctrl.signal.aborted) break;
        if (!error.retryable || ++failures >= 5) throw error;
      }
      try { await delay(interval,undefined,{signal:ctrl.signal}); } catch(error) {
        if (!ctrl.signal.aborted) throw error;
      }
    }
  } finally { c.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error=>{
    console.error(error instanceof TypeError || error instanceof ConnectorError ? error.message : 'Host connector stopped; inspect local state setup.');
    process.exitCode = 1;
  });
}
