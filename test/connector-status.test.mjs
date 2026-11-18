import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnector} from '../connector/status.mjs';

const token='aw_host_'+('a'.repeat(43));
const origin='http://127.0.0.1:4319';
const job={id:'check-1',hostId:'host-1',action:'report_status',status:'claimed',receiptId:'receipt-1'};
const json=(payload,status=200)=>new Response(JSON.stringify(payload),{status});

test('refresh uses only three allowed host operations and rejects unsafe token destinations',async()=>{
  for(const base of ['http://192.0.2.23:4319','http://localhost:4319','https://me:password@example.test/','https://example.test/key','https://example.test/?q=x','https://example.test/#key','file:///tmp/sock']) {
    assert.throws(()=>createConnector({baseUrl:base,token}),/origin/i,base);
  }
  assert.throws(()=>createConnector({baseUrl:origin,token:'aw_agent_'+'a'.repeat(43)}),/host token/i);
  const seen=[];
  const c=createConnector({baseUrl:origin,token,fetchImpl:async(url,options)=>{
    seen.push([url,options]);
    if(url.endsWith('/claim')) return json({check:job});
    if(url.endsWith('/ack')) return json({check:{...job,status:'completed'}});
    return json({host:{id:'host-1'}});
  }});
  try{
    assert.equal(await c.tick(),'completed');
    assert.deepEqual(seen.map(([u])=>new URL(u).pathname),['/api/host/heartbeat','/api/host/status-checks/claim','/api/host/status-checks/check-1/ack']);
    for(const [url,opts] of seen) {
      assert.equal(new URL(url).origin,origin);
      assert.equal(opts.redirect,'error');
      assert.equal(opts.headers.Authorization,'Bearer '+token);
      assert.equal(opts.method,'POST');
    }
    assert.deepEqual(JSON.parse(seen[2][1].body),{receiptId:'receipt-1',result:{platform:process.platform,connectorVersion:'0.1.0'}});
  }finally{c.close()}
});

test('after a lost ACK and process restart, reuse the persisted result and never claim again first',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'workspace-connector-'));const dbPath=join(dir,'receipt.sqlite');
  const sent=[];
  const fetchImpl=async(url,options)=>{
    if(url.endsWith('/claim')){sent.push(['claim',options.body]);return json({check:job})}
    if(url.endsWith('/ack')){sent.push(['ack',options.body]);if(sent.length===2) throw Error('connection lost');return json({check:{...job,status:'completed'}})}
    return json({host:{id:'host-1'}});
  };
  try{
    let c=createConnector({baseUrl:origin,token,dbPath,fetchImpl});
    try {await assert.rejects(c.tick(),/transport/)}finally{c.close()}
    assert.throws(()=>createConnector({baseUrl:'https://different.example',token,dbPath,fetchImpl}),/bound/i);
    assert.throws(()=>createConnector({baseUrl:origin,token:'aw_host_'+'b'.repeat(43),dbPath,fetchImpl}),/bound/i);
    c=createConnector({baseUrl:origin,token,dbPath,fetchImpl});
    try{assert.equal(await c.tick(),'completed')}finally{c.close()}
    assert.deepEqual(sent.map(([kind])=>kind),['claim','ack','ack']);
    assert.equal(sent[1][1],sent[2][1]);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('reuse a request ID for lost claim responses and never acknowledge an unknown action',async()=>{
  const claims=[];
  const c=createConnector({baseUrl:origin,token,fetchImpl:async(url,options)=>{
    if(url.endsWith('/claim')){
      claims.push(options.body);
      if(claims.length===1) throw Error('lost');
      return json({check:{...job,action:'unsupported'}});
    }
    assert.ok(url.endsWith('/heartbeat'));
    return json({host:{id:'host-1'}});
  }});
  try{
    await assert.rejects(c.tick(),/transport/);
    await assert.rejects(c.tick(),/unsupported/);
    assert.equal(claims[0],claims[1]);
  }finally{c.close()}
});

test('redirects and invalid tokens are never followed or written to logs',async()=>{
  const c=createConnector({baseUrl:'https://example.test/',token,fetchImpl:async(_url,opts)=>{
    assert.equal(opts.redirect,'error');return new Response('',{status:302,headers:{Location:'https://other.example/'}});
  }});
  try{await assert.rejects(c.tick(),error=>/302/.test(error.message)&&!error.message.includes(token))}finally{c.close()}
});

test('real HTTP: heartbeat, owner approval, lost ACK, durable restart, and revocation',async t=>{
  const {createWorkspaceServer}=await import('../server/index.mjs');
  const {openWorkspace}=await import('../server/workspace.mjs');
  const dir=mkdtempSync(join(tmpdir(),'workspace-real-connector-')),dbPath=join(dir,'receipts.sqlite');
  const store=openWorkspace(':memory:');
  const ownerToken='connector-integration-owner-token-abcd';
  const server=createWorkspaceServer({store,ownerToken});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const baseUrl='http://127.0.0.1:'+server.address().port;
  const owner=(path,body={})=>fetch(baseUrl+path,{method:'POST',headers:{Authorization:'Bearer '+ownerToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const registration=await owner('/api/hosts',{name:'Synthetic diagnostic fixture'});
  assert.equal(registration.status,201);
  const {host,token:hostToken}=await registration.json();

  let delivered=0,claims=0;
  const fetchImpl=async(url,opts)=>{
    const response=await fetch(url,opts);
    if(url.endsWith('/claim')) claims++;
    if(url.endsWith('/ack') && ++delivered===1){
      assert.equal(response.status,200);
      await response.text();
      throw Error('Synthetic loss after server ACK commit');
    }
    return response;
  };
  let c=createConnector({baseUrl,token:hostToken,dbPath,fetchImpl});
  try{
    assert.equal(await c.tick(),'idle');
    const requested=await owner('/api/hosts/'+host.id+'/status-checks',{clientRequestId:'owner-approved'});
    assert.equal(requested.status,201);
    await assert.rejects(c.tick(),/transport/);
    assert.equal(claims,2);
  }finally{c.close()}

  c=createConnector({baseUrl,token:hostToken,dbPath,fetchImpl});
  try{
    assert.equal(await c.tick(),'completed');
    assert.equal(claims,2);
    assert.equal(delivered,2);
    assert.equal((await owner('/api/hosts/'+host.id+'/revoke')).status,200);
    await assert.rejects(c.tick(),/401/);
  }finally{c.close()}
});

test('bounds coordinator payloads and refuses to claim without a valid heartbeat',async()=>{
  for (const [response, expected] of [
    [new Response(null,{status:204}),/empty response/],
    [new Response('x'.repeat(64*1024+1)),/exceeds the size limit/],
    [new Response('{'),/unreadable response/],
    [json([]),/unreadable response/],
    [json({host:{}}),/did not identify/],
  ]) {
    const seen=[];
    const c=createConnector({baseUrl:origin,token,fetchImpl:async url=>{seen.push(url);return response;}});
    try {
      await assert.rejects(c.tick(),expected);
      assert.deepEqual(seen,[origin+'/api/host/heartbeat']);
    } finally {c.close();}
  }
  for (const requestTimeoutMs of [0,1.5,30_001]) {
    assert.throws(()=>createConnector({baseUrl:origin,token,requestTimeoutMs}),/request timeout/i);
  }
});

test('a mismatched ACK confirmation leaves the receipt pending and completed claims do not send another ACK',async()=>{
  const calls=[];
  let claim=0,ack=0;
  const c=createConnector({baseUrl:origin,token,fetchImpl:async(url,opts)=>{
    if (url.endsWith('/heartbeat')) return json({host:{id:job.hostId}});
    const payload=JSON.parse(opts.body);
    calls.push([url,payload]);
    if(url.endsWith('/claim')) return json({check:++claim===1?job:{...job,status:'completed'}});
    if(url.endsWith('/ack')) return json({check:{id:++ack===1?'another-check':job.id,status:'completed'}});
    assert.fail('unexpected request');
  }});
  try {
    await assert.rejects(c.tick(),/did not confirm this exact receipt/);
    assert.equal(await c.tick(),'completed');
    assert.equal(await c.tick(),'completed');
    assert.deepEqual(calls.map(([url])=>url.split('/').at(-1)),['claim','ack','ack','claim']);
    assert.deepEqual(calls[1][1],calls[2][1]);
    assert.notEqual(calls[0][1].requestId,calls[3][1].requestId);
  } finally {c.close();}
});

test('overlapping polls are rejected and a timed-out or aborted request leaves the connector reusable',async()=>{
  const admitted=[];
  const c=createConnector({baseUrl:origin,token,requestTimeoutMs:30,fetchImpl:async(url,{signal})=>{
    admitted.push(url);
    if (admitted.length<=2) await delay(2000,undefined,{signal});
    return url.endsWith('/heartbeat')?json({host:{id:job.hostId}}):json({check:null});
  }});
  const external=new AbortController();
  try {
    const timeout=c.tick();
    await assert.rejects(c.tick(),/one poll/);
    await assert.rejects(timeout,{message:'Coordinator transport interrupted.',retryable:true});
    const cancelled=c.tick(external.signal);
    external.abort();
    await assert.rejects(cancelled,{message:'Coordinator transport interrupted.',retryable:true});
    assert.equal(await c.tick(),'idle');
    assert.deepEqual(admitted.map(url=>url.split('/').at(-1)),['heartbeat','heartbeat','heartbeat','claim']);
  } finally {c.close();}
});

test('a second connector that raced for the same receipt cannot ACK after the journal has changed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'workspace-journal-race-'));
  const dbPath=join(dir,'receipt.sqlite');
  const release=Promise.withResolvers(), requested=Promise.withResolvers();
  let activeAcks=0;
  const create=slow=>createConnector({baseUrl:origin,token,dbPath,fetchImpl:async(url,opts)=>{
    if(url.endsWith('/heartbeat')) return json({host:{id:job.hostId}});
    if(url.endsWith('/claim')){
      const {requestId}=JSON.parse(opts.body);
      if(slow){requested.resolve(requestId);await release.promise;}
      else assert.equal(requestId,await requested.promise);
      return json({check:job});
    }
    activeAcks++;
    return json({check:{id:job.id,status:'completed'}});
  }});
  const a=create(true),b=create(false);
  try {
    const stale=a.tick();
    await requested.promise;
    assert.equal(await b.tick(),'completed');
    release.resolve();
    await assert.rejects(stale,/journal changed/);
    assert.equal(activeAcks,1);
  } finally {
    release.resolve();a.close();b.close();rmSync(dir,{recursive:true,force:true});
  }
});

const entry=fileURLToPath(new URL('../connector/status.mjs',import.meta.url));
function launchConnector(t,overrides={}) {
  const child=spawn(process.execPath,[entry],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,WORKSPACE_CONNECTOR_ORIGIN:origin,WORKSPACE_CONNECTOR_TOKEN:token,
      WORKSPACE_CONNECTOR_POLL_MS:'1000',WORKSPACE_CONNECTOR_STATE_DIR:'',...overrides}});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',v=>stdout+=v);
  child.stderr.setEncoding('utf8').on('data',v=>stderr+=v);
  const exit=once(child,'close').then(([code,signal])=>({code,signal,stdout,stderr}));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null) child.kill();await exit;});
  return {child,exit};
}

test('CLI fails closed before networking for incomplete or invalid startup settings',{timeout:5000},async t=>{
  for(const [env,error] of [[{},/STATE_DIR/],[{WORKSPACE_CONNECTOR_STATE_DIR:tmpdir(),WORKSPACE_CONNECTOR_POLL_MS:'10'},/POLL_MS/]]){
    const {exit}=launchConnector(t,env);
    const result=await exit;
    assert.equal(result.code,1);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,error);
    assert.ok(!result.stderr.includes(token));
  }
});

async function cliFixture(t,handler) {
  const dir=mkdtempSync(join(tmpdir(),'workspace-cli-status-'));
  const server=createServer(handler);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  return {WORKSPACE_CONNECTOR_STATE_DIR:dir,WORKSPACE_CONNECTOR_ORIGIN:'http://127.0.0.1:'+server.address().port};
}

test('CLI recovers from one transient response, then stops after the credential is revoked',{timeout:8000},async t=>{
  let heartbeats=0,claims=0;
  const env=await cliFixture(t,(req,res)=>{
    req.resume();
    assert.equal(req.headers.authorization,'Bearer '+token);
    res.setHeader('Content-Type','application/json');
    if (req.url==='/api/host/heartbeat') {
      heartbeats++;
      if(heartbeats===1){res.writeHead(503);res.end('{"error":"synthetic maintenance"}');}
      else if(heartbeats===2) res.end('{"host":{"id":"fixture"}}');
      else {res.writeHead(401);res.end('{"error":"revoked"}');}
    } else {
      assert.equal(req.url,'/api/host/status-checks/claim');
      claims++;res.end('{"check":null}');
    }
  });
  const result=await launchConnector(t,env).exit;
  assert.equal(result.code,1);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/HTTP 401/);
  assert.ok(!result.stderr.includes(token));
  assert.equal(heartbeats,3);
  assert.equal(claims,1);
});

test('CLI SIGTERM aborts an in-flight heartbeat without claiming or printing credentials',{skip:process.platform==='win32',timeout:5000},async t=>{
  const called=Promise.withResolvers();
  const env=await cliFixture(t,(req,_res)=>{
    req.resume();called.resolve(req.url);
  });
  const {child,exit}=launchConnector(t,env);
  assert.equal(await called.promise,'/api/host/heartbeat');
  child.kill('SIGTERM');
  assert.deepEqual(await exit,{code:0,signal:null,stdout:'',stderr:''});
});
