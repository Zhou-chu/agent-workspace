import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hostTTL=120_000, receiptTTL=180_000, waitingTTL=600_000;
const deny=(status,message)=>{throw Object.assign(new Error(message),{status});};
const hash=s=>createHash('sha256').update(s).digest('hex');
const text=(v,label,max)=>typeof v==='string'&&v.length<=max&&v.trim() ? v.trim() : deny(400,'Invalid '+label);
const tokenPattern=/^aw_host_[A-Za-z0-9_-]{43}$/;
const request=(v,label)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : deny(400,'Invalid '+label);
const fields=(value,allowed)=>{
  if (!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!allowed.includes(k))) deny(400,'Unrecognized request fields');
};
const hostState=(row,t)=>row.revoked ? 'revoked' : row.last_seen===null ? 'never_seen' : t-row.last_seen>hostTTL ? 'offline' : 'online';
const iso=t=>t===null ? null : new Date(t).toISOString();
const hostDto=(r,t)=>({id:r.id,name:r.name,status:hostState(r,t),createdAt:iso(r.created_at),lastSeenAt:iso(r.last_seen)});
const checkState=(r,t)=>r.state==='claimed'&&t-r.claimed_at>receiptTTL ? 'uncertain' :
  r.state==='pending'&&t-r.created_at>waitingTTL ? 'expired' : r.state;
const checkDto=(r,t)=>({id:r.id,hostId:r.host_id,action:'report_status',status:checkState(r,t),createdAt:iso(r.created_at),result:r.result===null?null:JSON.parse(r.result)});
const claimDto=(r,t)=>({...checkDto(r,t),receiptId:r.receipt_id});
function statusResult(v) {
  fields(v,['platform','connectorVersion']);
  const os=['win32','darwin','linux','freebsd','openbsd','android','aix','sunos','other'];
  if (!os.includes(v.platform)||typeof v.connectorVersion!=='string'||!/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(v.connectorVersion))
    deny(400,'Invalid status report');
  return JSON.stringify({platform:v.platform,connectorVersion:v.connectorVersion});
}

export function openHosts(db,{clock,requireOwner,tx}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_hosts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES actors(id),
      token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_status_checks (
      id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES workspace_hosts(id), approved_by TEXT NOT NULL REFERENCES actors(id),
      request_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','claimed','uncertain','completed','cancelled','expired')),
      created_at INTEGER NOT NULL, claimed_at INTEGER, claim_request_id TEXT, receipt_id TEXT, result TEXT,
      UNIQUE(host_id,request_id), UNIQUE(host_id,claim_request_id)
    );
    CREATE INDEX IF NOT EXISTS host_status_check_pending ON host_status_checks(host_id,state,created_at);
  `);
  const get=(q,...args)=>db.prepare(q).get(...args), all=(q,...args)=>db.prepare(q).all(...args);
  const run=(q,...args)=>db.prepare(q).run(...args);
  const selectHost=id=>get('SELECT * FROM workspace_hosts WHERE id=?',id);
  const own=(a,id)=>{
    requireOwner(a);
    const row=selectHost(id);
    if (!row||row.owner_id!==a.id) deny(404,'Host not found');
    return row;
  };
  const active=principal=>{
    if (!principal?.id) deny(401,'Host authentication required');
    const row=selectHost(principal.id);
    if (!row||row.revoked) deny(401,'Host authentication required');
    return row;
  };
  const query=rowId=>get('SELECT * FROM host_status_checks WHERE id=?',rowId);
  const expire=(hostId,t)=>{
    run("UPDATE host_status_checks SET state='uncertain' WHERE host_id=? AND state='claimed' AND claimed_at<?",hostId,t-receiptTTL);
    run("UPDATE host_status_checks SET state='expired' WHERE host_id=? AND state='pending' AND created_at<?",hostId,t-waitingTTL);
  };
  return {
    register(a,input) {
      requireOwner(a);
      fields(input,['name']);
      const name=text(input.name,'host name',100);
      const id=randomUUID(), token='aw_host_'+randomBytes(32).toString('base64url'), t=clock();
      run('INSERT INTO workspace_hosts(id,name,owner_id,token_hash,created_at) VALUES (?,?,?,?,?)',id,name,a.id,hash(token),t);
      return {host:hostDto(selectHost(id),t),token};
    },
    list(a) {
      requireOwner(a);
      const t=clock();
      return all('SELECT * FROM workspace_hosts WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100',a.id).map(r=>hostDto(r,t));
    },
    revoke(a,id) {
      return tx(()=>{
        const host=own(a,id), t=clock();
        run('UPDATE workspace_hosts SET revoked=1 WHERE id=?',host.id);
        run("UPDATE host_status_checks SET state='cancelled' WHERE host_id=? AND state='pending'",host.id);
        run("UPDATE host_status_checks SET state='uncertain' WHERE host_id=? AND state='claimed'",host.id);
        return hostDto(selectHost(host.id),t);
      });
    },
    authenticate(token) {
      if (typeof token!=='string'||!tokenPattern.test(token)) return null;
      const row=get('SELECT id FROM workspace_hosts WHERE token_hash=? AND revoked=0',hash(token));
      return row ? {id:row.id} : null;
    },
    heartbeat(principal,input) {
      fields(input,[]);
      return tx(()=>{
        const host=active(principal), t=clock();
        expire(host.id,t);
        run('UPDATE workspace_hosts SET last_seen=? WHERE id=?',t,host.id);
        return hostDto(selectHost(host.id),t);
      });
    },
    requestCheck(a,id,input) {
      fields(input,['clientRequestId']);
      const key=request(input.clientRequestId,'clientRequestId');
      return tx(()=>{
        const host=own(a,id), t=clock();
        expire(host.id,t);
        const duplicate=get('SELECT * FROM host_status_checks WHERE host_id=? AND request_id=?',host.id,key);
        if (duplicate) return checkDto(duplicate,t);
        if (hostState(host,t)!=='online') deny(409,'Host must be online');
        const pending=get("SELECT COUNT(*) n FROM host_status_checks WHERE host_id=? AND state IN ('pending','claimed')",host.id);
        if (pending.n>=8) deny(409,'Host status queue is full');
        const checkId=randomUUID();
        run("INSERT INTO host_status_checks(id,host_id,approved_by,request_id,state,created_at) VALUES (?,?,?,?,'pending',?)",checkId,host.id,a.id,key,t);
        return checkDto(query(checkId),t);
      });
    },
    listChecks(a,id) {
      const host=own(a,id), t=clock();
      return all('SELECT * FROM host_status_checks WHERE host_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100',host.id).map(r=>checkDto(r,t));
    },
    claim(principal,input) {
      fields(input,['requestId']);
      const key=request(input.requestId,'requestId');
      return tx(()=>{
        const host=active(principal), t=clock();
        expire(host.id,t);
        if (hostState(host,t)!=='online') deny(409,'Heartbeat required before claiming');
        const already=get('SELECT * FROM host_status_checks WHERE host_id=? AND claim_request_id=?',host.id,key);
        if (already) return claimDto(already,t);
        const busy=get("SELECT 1 FROM host_status_checks WHERE host_id=? AND state='claimed'",host.id);
        if (busy) return null;
        const next=get("SELECT * FROM host_status_checks WHERE host_id=? AND state='pending' ORDER BY created_at,rowid LIMIT 1",host.id);
        if (!next) return null;
        const receipt=randomBytes(24).toString('base64url');
        run("UPDATE host_status_checks SET state='claimed',claimed_at=?,claim_request_id=?,receipt_id=? WHERE id=? AND state='pending'",t,key,receipt,next.id);
        return claimDto(query(next.id),t);
      });
    },
    ack(principal,id,input) {
      fields(input,['receiptId','result']);
      const receipt=request(input.receiptId,'receiptId'), result=statusResult(input.result);
      return tx(()=>{
        const host=active(principal), t=clock();
        expire(host.id,t);
        const row=query(id);
        if (!row||row.host_id!==host.id||row.receipt_id!==receipt) deny(404,'Status receipt not found');
        if (row.state==='completed') {
          if (row.result!==result) deny(409,'Status report does not match recorded receipt');
          return checkDto(row,t);
        }
        if (!['claimed','uncertain'].includes(row.state)) deny(409,'Status receipt cannot be accepted');
        run("UPDATE host_status_checks SET result=?,state='completed' WHERE id=?",result,id);
        return checkDto(query(id),t);
      });
    },
  };
}
