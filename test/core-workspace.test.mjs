import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorkspace } from '../server/workspace.mjs';

test('explicit mentions only; retry returns same message without creating a new reminder', () => {
  const store = openWorkspace(':memory:');
  const owner = store.owner;
  const { agent, token } = store.createAgent(owner, { name: 'alpha' });
  const a = store.authenticateAgent(token);
  const ordinary = store.send(owner, 'general', { clientRequestId:'one', body:'@alpha in text' });
  assert.equal(store.listReminders(a).length, 0);
  const input = { clientRequestId:'two', body:'please read', mentions:[agent.id, agent.id], replyTo:ordinary.id };
  const m = store.send(owner, 'general', input);
  assert.deepEqual(store.send(owner, 'general', input), m);
  assert.deepEqual(store.listReminders(a).map(r => [r.message.id, r.message.body]), [[m.id,'please read']]);
  assert.equal(store.listReminders(a)[0].message.quotedBody, undefined);
  assert.throws(() => store.send(owner,'general',{ ...input, body:'changed' }), { status:409 });
  assert.equal(store.listMessages(a,'general',{ limit:1 }).hasMore,true);
  assert.throws(() => store.send(a,'general',{clientRequestId:'bad',body:'no',mentions:['unknown']}), {status:400});
  store.close();
});

test('agents cannot mutate the human decision, forge the author, or use a disabled credential', () => {
  const store = openWorkspace(':memory:');
  const owner = store.owner;
  const {agent,token} = store.createAgent(owner,{name:'alpha'});
  const a = store.authenticateAgent(token);
  const m = store.send(a,'general',{clientRequestId:'m',body:'agent',authorId:owner.id});
  assert.equal(m.authorId,a.id);
  const d = store.createDecision(a,{roomId:'general',question:'Review result?',options:['accept','reject']});
  assert.throws(() => store.resolveDecision(a,d.id,{response:'accept'}),{status:403});
  assert.equal(store.resolveDecision(owner,d.id,{response:'accept'}).status,'resolved');
  assert.throws(() => store.resolveDecision(owner,d.id,{response:'reject'}),{status:409});
  store.setAgentEnabled(owner,agent.id,false);
  assert.equal(store.authenticateAgent(token),null);
  assert.throws(() => store.listMessages(a,'general',{}),{status:403});
  store.close();
});

test('room membership is scoped and removal cancels pending targeted delivery', () => {
  const store = openWorkspace(':memory:');
  const owner = store.owner;
  const { agent, token } = store.createAgent(owner,{name:'Member'});
  const a=store.authenticateAgent(token);
  const room=store.createRoom(owner,{name:'Project'});
  assert.throws(()=>store.listMessages(a,room.id,{}),{status:404});
  assert.throws(()=>store.createRoom(a,{name:'forged'}),{status:403});
  assert.throws(()=>store.send(owner,room.id,{clientRequestId:'1',body:'test',mentions:[agent.id]}),{status:400});
  store.setRoomMember(owner,room.id,agent.id,true);
  assert.deepEqual(store.listRoomMembers(a,room.id).map(x=>x.id).sort(),[agent.id,owner.id].sort());
  store.send(owner,room.id,{clientRequestId:'1',body:'approved',mentions:[agent.id]});
  assert.equal(store.listReminders(a)[0].status,'pending');
  store.setRoomMember(owner,room.id,agent.id,false);
  assert.deepEqual(store.listReminders(a),[]);
  assert.throws(()=>store.listRoomMembers(a,room.id),{status:404});
  store.setRoomMember(owner,room.id,agent.id,true);
  assert.equal(store.listReminders(a)[0].status,'cancelled');
  store.close();
});

test('agent consumers have isolated monotone positions, and reminder reads do not advance them', () => {
  const store=openWorkspace(':memory:');
  const owner=store.owner;
  const {agent,token}=store.createAgent(owner,{name:'Agent'});
  const a=store.authenticateAgent(token);
  store.send(owner,'general',{clientRequestId:'1',body:'first'});
  store.send(owner,'general',{clientRequestId:'2',body:'later',mentions:[agent.id]});
  assert.equal(store.listReminders(a)[0].message.body,'later');
  assert.deepEqual(store.listMessages(a,'general',{consumer:'a',limit:1}).messages.map(m=>m.body),['first']);
  assert.deepEqual(store.listMessages(a,'general',{consumer:'b',limit:1}).messages.map(m=>m.body),['first']);
  assert.deepEqual(store.listMessages(a,'general',{consumer:'a',limit:1}).messages.map(m=>m.body),['later']);
  store.listMessages(a,'general',{consumer:'a',after:'0',limit:1});
  assert.deepEqual(store.listMessages(a,'general',{consumer:'a'}).messages,[]);
  assert.deepEqual(store.listMessages(a,'general',{consumer:'b'}).messages.map(m=>m.body),['later']);
  store.close();
});

test('file database preserves rooms, reminders, credentials and read positions after restart', async t => {
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const tmp=await mkdtemp(join(tmpdir(),'workspace-core-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const db=join(tmp,'db.sqlite');
  let store=openWorkspace(db);
  const owner=store.owner;
  const {agent,token}=store.createAgent(owner,{name:'Persistent agent'});
  const a=store.authenticateAgent(token);
  const room=store.createRoom(owner,{name:'Persistent room'});
  store.setRoomMember(owner,room.id,agent.id,true);
  const m=store.send(owner,room.id,{clientRequestId:'persist',body:'hello',mentions:[agent.id]});
  store.listMessages(a,room.id,{consumer:'same'});
  store.close();
  store=openWorkspace(db);
  assert.deepEqual(store.authenticateAgent(token),a);
  assert.deepEqual(store.listReminders(a).map(x=>x.message.id),[m.id]);
  assert.deepEqual(store.listMessages(a,room.id,{consumer:'same'}).messages,[]);
  assert.deepEqual(store.listMessages(a,room.id,{consumer:'different'}).messages.map(x=>x.id),[m.id]);
  store.close();
});

test('task decisions keep review distinct from execution and use an atomic version check', () => {
  const store=openWorkspace(':memory:');
  const owner=store.owner;
  const {agent,token}=store.createAgent(owner,{name:'Engineer'});
  const a=store.authenticateAgent(token);
  const prior=store.createTask(owner,{roomId:'general',title:'Prior'});
  const job=store.createTask(owner,{roomId:'general',title:'Follow-up',assigneeId:agent.id,dependencyIds:[prior.id]});
  assert.throws(()=>store.updateTask(a,job.id,{status:'in_progress',expectedVersion:1}),{status:409});
  assert.throws(()=>store.updateTask(a,job.id,{status:'accepted',expectedVersion:1}),{status:403});
  let p=store.updateTask(owner,prior.id,{status:'in_progress',expectedVersion:1});
  p=store.updateTask(owner,p.id,{status:'review_requested',expectedVersion:p.version});
  p=store.updateTask(owner,p.id,{status:'accepted',expectedVersion:p.version});
  assert.equal(p.status,'accepted');
  let j=store.updateTask(a,job.id,{status:'in_progress',expectedVersion:1});
  assert.throws(()=>store.updateTask(owner,j.id,{status:'cancelled',expectedVersion:1}),{status:409});
  j=store.updateTask(a,j.id,{status:'review_requested',expectedVersion:j.version});
  assert.equal(j.status,'review_requested');
  assert.equal(store.updateTask(owner,j.id,{status:'accepted',expectedVersion:j.version}).status,'accepted');
  store.close();
});
