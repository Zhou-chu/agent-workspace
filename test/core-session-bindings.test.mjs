import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspace } from '../server/workspace.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'aw-bindings-'));
  const path=join(root,'workspace.sqlite');
  let store=openWorkspace(path);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const owner=store.owner;
  const {agent}=store.createAgent(owner,{name:'Primary'});
  const {agent:peer}=store.createAgent(owner,{name:'Peer'});
  const {host,token}=store.hosts.register(owner,{name:'Local fixture host'});
  const task=store.createTask(owner,{roomId:'general',title:'Assigned work',assigneeId:agent.id});
  const base={roomId:'general',agentId:agent.id,hostId:host.id,harness:'codex',generation:1,expectedBindingId:null};
  return {
    get store(){return store;},path,owner,agent,peer,host,token,task,base,
    reopen(){store.close();store=openWorkspace(path);},
  };
}

test('an explicit task mention selects only its native binding and never falls back', t=>{
  const f=fixture(t), s=f.store;
  const defaultBinding=s.sessionBindings.set(f.owner,{...f.base,sessionId:'synthetic-default'});
  const toAgent={body:'review',mentions:[f.agent.id,f.agent.id]};
  const sent=s.send(f.owner,'general',{...toAgent,clientRequestId:'missing',taskRef:f.task.id});
  assert.deepEqual(s.sessionBindings.route(f.owner,'general',sent.id,f.agent.id),{status:'blocked_no_binding',bindingId:null,generation:null});
  const taskBinding=s.sessionBindings.set(f.owner,{...f.base,taskId:f.task.id,sessionId:'synthetic-task'});
  const taskMsg=s.send(f.owner,'general',{...toAgent,clientRequestId:'task',taskRef:f.task.id});
  const reply=s.send(f.owner,'general',{...toAgent,clientRequestId:'default',replyTo:taskMsg.id});
  assert.deepEqual(s.sessionBindings.route(f.owner,'general',taskMsg.id,f.agent.id),{status:'selected_not_dispatched',bindingId:taskBinding.id,generation:1});
  assert.deepEqual(s.sessionBindings.route(f.owner,'general',reply.id,f.agent.id),{status:'selected_not_dispatched',bindingId:defaultBinding.id,generation:1});
  assert.equal(JSON.stringify(s.listReminders(f.agent)).includes('synthetic-'),false);
  const hostPrincipal=s.hosts.authenticate(f.token);
  s.hosts.heartbeat(hostPrincipal,{});
  assert.equal(s.hosts.claim(hostPrincipal,{requestId:'no-dispatch'}),null);
});

test('generation, scope CAS and durable frozen receipts prevent rebinding a retry',t=>{
  const f=fixture(t), s=f.store;
  const input={...f.base,sessionId:'synthetic-stable'};
  const original=s.sessionBindings.set(f.owner,input);
  const payload={clientRequestId:'retry',body:'request',mentions:[f.agent.id]};
  const first=s.send(f.owner,'general',payload);
  assert.throws(()=>s.sessionBindings.set(f.owner,{...input,generation:2}),{status:409});
  assert.throws(()=>s.sessionBindings.set(f.owner,{...input,expectedBindingId:original.id}),{status:409});
  const successor=s.sessionBindings.set(f.owner,{...input,generation:2,expectedBindingId:original.id});
  assert.throws(()=>s.sessionBindings.retire(f.owner,{roomId:'general',agentId:f.agent.id,expectedBindingId:original.id}),{status:409});
  f.reopen();
  assert.deepEqual(f.store.send(f.owner,'general',payload),first);
  assert.deepEqual(f.store.sessionBindings.route(f.owner,'general',first.id,f.agent.id),{status:'selected_not_dispatched',bindingId:original.id,generation:1});
  const second=f.store.send(f.owner,'general',{...payload,clientRequestId:'new'});
  assert.deepEqual(f.store.sessionBindings.route(f.owner,'general',second.id,f.agent.id),{status:'selected_not_dispatched',bindingId:successor.id,generation:2});
  f.store.sessionBindings.retire(f.owner,{roomId:'general',agentId:f.agent.id,expectedBindingId:successor.id});
  assert.throws(()=>f.store.sessionBindings.set(f.owner,{...input,generation:2}),{status:409});
});

test('owner-only binding, exclusive native identity, room and task validation, no peer routing',t=>{
  const f=fixture(t), s=f.store, b=s.sessionBindings;
  const input={...f.base,sessionId:'synthetic-exclusive'};
  for(const untrusted of [f.agent,s.hosts.authenticate(f.token)]) assert.throws(()=>b.set(untrusted,input),{status:403});
  const original=b.set(f.owner,input);
  assert.throws(()=>b.set(f.owner,{...input,agentId:f.peer.id,taskId:f.task.id}),{status:400});
  assert.throws(()=>b.set(f.owner,{...input,taskId:f.task.id,generation:2}),{status:409});
  const other=s.createRoom(f.owner,{name:'Other'});
  assert.throws(()=>b.set(f.owner,{...input,roomId:other.id}),{status:404});
  s.setRoomMember(f.owner,other.id,f.agent.id,true);
  assert.throws(()=>b.set(f.owner,{...input,roomId:other.id,taskId:f.task.id}),{status:400});
  b.retire(f.owner,{roomId:'general',agentId:f.agent.id,expectedBindingId:original.id});
  assert.throws(()=>b.set(f.owner,{...input,roomId:other.id,generation:2}),{status:409});
  const ordinary=s.send(f.owner,'general',{clientRequestId:'plain',body:'@Primary'});
  const reply=s.send(f.owner,'general',{clientRequestId:'reply',body:'ordinary quote',replyTo:ordinary.id});
  const peer=s.send({...f.peer,kind:'human'},'general',{clientRequestId:'peer',body:'handoff',mentions:[f.agent.id]});
  for (const m of [ordinary,reply,peer]) assert.equal(b.route(f.owner,'general',m.id,f.agent.id),null);
  assert.throws(()=>b.route(f.agent,'general',peer.id,f.agent.id),{status:403});
  assert.equal(s.listReminders(f.agent)[0].status,'blocked_no_execution_context');
});

test('current revocation blocks future selection and reopening does not backfill historical reminders',t=>{
  const f=fixture(t);
  const old=f.store.send(f.owner,'general',{clientRequestId:'legacy',body:'legacy',mentions:[f.agent.id]});
  // Restore the original schema while preserving the original message and reminder.
  const db=new DatabaseSync(f.path);
  db.exec('DROP TABLE session_route_receipts; DROP TABLE session_bindings');
  db.close();
  f.reopen();
  const s=f.store, b=s.sessionBindings;
  const input={...f.base,sessionId:'synthetic-retire'};
  b.set(f.owner,input);
  s.setRoomMember(f.owner,'general',f.agent.id,false);
  s.setRoomMember(f.owner,'general',f.agent.id,true);
  const send=key=>s.send(f.owner,'general',{clientRequestId:key,body:'request',mentions:[f.agent.id]});
  const route=m=>b.route(f.owner,'general',m.id,f.agent.id)?.status;
  assert.equal(route(send('member')),'blocked_no_binding');
  b.set(f.owner,{...input,generation:2});
  s.setAgentEnabled(f.owner,f.agent.id,false);
  s.setAgentEnabled(f.owner,f.agent.id,true);
  assert.equal(route(send('enabled')),'blocked_no_binding');
  b.set(f.owner,{...input,generation:3});
  s.hosts.revoke(f.owner,f.host.id);
  assert.equal(route(send('host')),'blocked_no_binding');
  assert.throws(()=>b.set(f.owner,{...input,generation:4}),{status:404});
  f.reopen();
  const retry=f.store.send(f.owner,'general',{clientRequestId:'legacy',body:'legacy',mentions:[f.agent.id]});
  assert.equal(retry.id,old.id);
  assert.equal(f.store.sessionBindings.route(f.owner,'general',old.id,f.agent.id),null);
});

test('a terminal or differently assigned task cannot reach a room default',t=>{
  const f=fixture(t), s=f.store, b=s.sessionBindings;
  b.set(f.owner,{...f.base,sessionId:'synthetic-default'});
  b.set(f.owner,{...f.base,sessionId:'synthetic-task',taskId:f.task.id});
  const mention=(key,taskRef)=>s.send(f.owner,'general',{clientRequestId:key,body:'review',mentions:[f.agent.id],taskRef});
  s.updateTask(f.owner,f.task.id,{status:'cancelled',expectedVersion:1});
  const peerTask=s.createTask(f.owner,{roomId:'general',title:'Peer only',assigneeId:f.peer.id});
  for(const task of [f.task,peerTask]) {
    const m=mention(task.id,task.id);
    assert.deepEqual(b.route(f.owner,'general',m.id,f.agent.id),{status:'blocked_no_binding',bindingId:null,generation:null});
  }
});

test('independent connections do not overwrite an owner registration from a stale read',t=>{
  const f=fixture(t), one=f.store;
  const two=openWorkspace(f.path);
  try {
    const original=one.sessionBindings.set(f.owner,{...f.base,sessionId:'synthetic-shared'});
    const next={...f.base,sessionId:'synthetic-shared',generation:2,expectedBindingId:original.id};
    const replacement=two.sessionBindings.set(two.owner,next);
    assert.throws(()=>one.sessionBindings.set(f.owner,{...next,generation:3}),{status:409});
    const m=one.send(f.owner,'general',{clientRequestId:'latest',body:'review',mentions:[f.agent.id]});
    assert.deepEqual(one.sessionBindings.route(f.owner,'general',m.id,f.agent.id),
      {status:'selected_not_dispatched',bindingId:replacement.id,generation:2});
  } finally { two.close(); }
});
