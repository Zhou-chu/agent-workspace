import {test} from 'node:test';
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
  const {once} = await import('node:events');
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
