import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openWorkspace} from '../server/workspace.mjs';

test('only the owner registers hosts and a token authenticates only its own host', () => {
  let time=100_000;
  const w=openWorkspace(':memory:', 'Owner', {clock:()=>time});
  const {token:agentToken}=w.createAgent(w.owner,{name:'Agent'});
  const user=w.authenticateAgent(agentToken);
  assert.throws(()=>w.hosts.register(user,{name:'Forged'}),{status:403});
  const {host,token}=w.hosts.register(w.owner,{name:'Windows'});
  assert.equal(host.status,'never_seen');
  assert.equal(w.authenticateAgent(token),null);
  const identity=w.hosts.authenticate(token);
  assert.equal(identity.id,host.id);
  assert.equal(w.hosts.heartbeat(identity,{}).status,'online');
  time+=120_001;
  assert.equal(w.hosts.list(w.owner)[0].status,'offline');
  assert.equal(w.hosts.revoke(w.owner,host.id).status,'revoked');
  assert.equal(w.hosts.authenticate(token),null);
  assert.throws(()=>w.hosts.heartbeat(identity,{}),{status:401});
  w.close();
});

test('typed owner status request is idempotent, scoped and never replayed after uncertain delivery', () => {
  let time=100_000;
  const w=openWorkspace(':memory:', 'Owner', {clock:()=>time});
  const {host,token}=w.hosts.register(w.owner,{name:'Main'});
  const {host:second,token:otherToken}=w.hosts.register(w.owner,{name:'Second'});
  const identity=w.hosts.authenticate(token), other=w.hosts.authenticate(otherToken);
  assert.throws(()=>w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'1'}),{status:409});
  w.hosts.heartbeat(identity,{});
  w.hosts.heartbeat(other,{});
  const first=w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'1'});
  assert.deepEqual(w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'1'}),first);
  assert.throws(()=>w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'2',action:'run-command'}),{status:400});
  assert.equal(w.hosts.claim(other,{requestId:'other'}),null);
  const claim=w.hosts.claim(identity,{requestId:'first'});
  assert.equal(claim.id,first.id);
  assert.equal(claim.action,'report_status');
  assert.deepEqual(w.hosts.claim(identity,{requestId:'first'}),claim);
  assert.equal(w.hosts.claim(identity,{requestId:'next'}),null);
  time+=300_001;
  assert.equal(w.hosts.listChecks(w.owner,host.id)[0].status,'uncertain');
  w.hosts.heartbeat(identity,{});
  assert.equal(w.hosts.claim(identity,{requestId:'after-reconnect'}),null);
  assert.throws(()=>w.hosts.ack(other,claim.id,{receiptId:claim.receiptId,result:{platform:'linux',connectorVersion:'0.1.0'}}),{status:404});
  assert.deepEqual(w.hosts.listChecks(w.owner,second.id),[]);
  const result={platform:'win32',connectorVersion:'0.1.0'};
  const done=w.hosts.ack(identity,claim.id,{receiptId:claim.receiptId,result});
  assert.equal(done.status,'completed');
  assert.deepEqual(w.hosts.ack(identity,claim.id,{receiptId:claim.receiptId,result}),done);
  assert.throws(()=>w.hosts.ack(identity,claim.id,{receiptId:claim.receiptId,result:{...result,platform:'linux'}}),{status:409});
  const pending=w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'pending'});
  w.hosts.revoke(w.owner,host.id);
  assert.equal(w.hosts.listChecks(w.owner,host.id).find(x=>x.id===pending.id).status,'cancelled');
  w.close();
});

test('host queue only accepts bounded reports; stale pending requests expire without a new claim',()=>{
  let time=2_000_000;
  const w=openWorkspace(':memory:','Owner',{clock:()=>time});
  const {host,token}=w.hosts.register(w.owner,{name:'Queue'});
  try {
    const identity=w.hosts.authenticate(token);
    assert.throws(()=>w.hosts.heartbeat(identity,{hostId:'not-declared'}),{status:400});
    assert.throws(()=>w.hosts.claim(identity,{requestId:'not-online'}),{status:409});
    w.hosts.heartbeat(identity,{});
    const requested=Array.from({length:8},(_,i)=>w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'q'+i}));
    assert.throws(()=>w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'overflow'}),{status:409});
    const first=w.hosts.claim(identity,{requestId:'first'});
    assert.equal(first.id,requested[0].id);
    assert.throws(()=>w.hosts.ack(identity,first.id,{receiptId:'incorrect',result:{platform:'linux',connectorVersion:'0.1.0'}}),{status:404});
    assert.throws(()=>w.hosts.ack(identity,first.id,{receiptId:first.receiptId,result:{platform:'unsupported',connectorVersion:'0.1.0'}}),{status:400});
    time+=601_000;
    assert.deepEqual(w.hosts.listChecks(w.owner,host.id).map(x=>x.status),[...Array(7).fill('expired'),'uncertain']);
    w.hosts.heartbeat(identity,{});
    assert.equal(w.hosts.claim(identity,{requestId:'after'}),null);
    assert.equal(w.hosts.requestCheck(w.owner,host.id,{clientRequestId:'q1'}).status,'expired');
  } finally {w.close();}
});
