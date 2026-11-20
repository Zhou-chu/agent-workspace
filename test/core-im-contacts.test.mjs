import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace } from '../server/workspace.mjs';

test('human contact directory, explicit reciprocal acceptance, and deterministic private conversation', () => {
  const s=openWorkspace(':memory:');
  try {
    const owner=s.owner;
    const {human:a}=s.provisionHuman(owner,{name:'Alice'});
    const {human:b}=s.provisionHuman(owner,{name:'Bob'});
    const {agent}=s.createAgent(owner,{name:'Bob Agent'});
    const {human:accent}=s.provisionHuman(owner,{name:'Élodie'});
    assert.deepEqual(s.contacts.search(a,'bob'),[{id:b.id,name:'Bob',status:'none'}]);
    assert.deepEqual(s.contacts.search(a,' ÉLO '),[{id:accent.id,name:'Élodie',status:'none'}]);
    assert.deepEqual(s.contacts.search(a,' '),[]);
    assert.deepEqual(s.contacts.search(a,'Alice'),[]);
    assert.throws(()=>s.contacts.search(agent,'Bob'),{status:403});
    assert.throws(()=>s.contacts.openDirect(a,b.id),{status:404});
    assert.equal(s.contacts.request(a,b.id).changed,true);
    assert.equal(s.contacts.request(a,b.id).changed,false);
    assert.equal(s.contacts.request(b,a.id).status,'incoming');
    assert.deepEqual(s.contacts.list(b).incoming,[{id:a.id,name:'Alice'}]);
    assert.throws(()=>s.contacts.accept(a,b.id),{status:409});
    assert.equal(s.contacts.accept(b,a.id).changed,true);
    assert.equal(s.contacts.accept(b,a.id).changed,false);
    const room=s.contacts.openDirect(a,b.id);
    assert.equal(room.kind,'direct');
    assert.deepEqual(room.peer,{id:b.id,name:'Bob'});
    assert.equal(room.created,true);
    const reopened=s.contacts.openDirect(b,a.id);
    assert.equal(reopened.id,room.id);
    assert.equal(reopened.created,false);
    assert.equal(s.contacts.rooms(a).some(x=>x.id===room.id),true);
    assert.equal(s.listRooms(a).some(x=>x.id===room.id),false);
    assert.equal(s.listRooms(owner).some(x=>x.id===room.id),false);
    assert.throws(()=>s.listMessages(owner,room.id,{}),{status:404});
    assert.throws(()=>s.send(agent,room.id,{clientRequestId:'x',body:'policy fixture'}),{status:404});
    const ownRoom=s.contacts.request(owner,a.id);
    assert.equal(ownRoom.status,'outgoing');
    s.contacts.accept(a,owner.id);
    const direct=s.contacts.openDirect(owner,a.id);
    assert.throws(()=>s.setRoomHumanMember(owner,direct.id,b.id,true),{status:409});
    assert.throws(()=>s.setRoomMember(owner,direct.id,agent.id,true),{status:409});
  } finally {s.close();}
});

test('human unread cursor is actor-bound, room-bound, monotone, and persists across reopen',t=>{
  const dir=mkdtempSync(join(tmpdir(),'agentchat-contacts-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'ledger.sqlite');
  let s=openWorkspace(path);
  try {
    const a=s.provisionHuman(s.owner,{name:'A'}).human;
    const b=s.provisionHuman(s.owner,{name:'B'}).human;
    s.contacts.request(a,b.id);s.contacts.accept(b,a.id);
    const dm=s.contacts.openDirect(a,b.id);
    s.send(a,dm.id,{clientRequestId:'one',body:'One'});
    const one=s.listMessages(b,dm.id,{}).nextCursor;
    s.send(a,dm.id,{clientRequestId:'two',body:'Two'});
    const two=s.listMessages(b,dm.id,{}).nextCursor;
    s.send(a,'general',{clientRequestId:'elsewhere',body:'Other room'});
    const other=s.listMessages(b,'general',{}).nextCursor;
    assert.throws(()=>s.contacts.markRead(b,dm.id,other),{status:400});
    assert.equal(s.contacts.rooms(a).find(r=>r.id===dm.id).unread,0);
    assert.equal(s.contacts.rooms(b).find(r=>r.id===dm.id).unread,2);
    const extra=s.send(a,dm.id,{clientRequestId:'retract',body:'Retract me'});
    assert.equal(s.contacts.rooms(b).find(r=>r.id===dm.id).unread,3);
    s.retractMessage(a,dm.id,extra.id);
    assert.equal(s.contacts.rooms(b).find(r=>r.id===dm.id).unread,2);
    assert.deepEqual(s.contacts.markRead(b,dm.id,two),{roomId:dm.id,cursor:two,unread:0,advanced:true});
    assert.equal(s.contacts.markRead(b,dm.id,one).cursor,two);
    s.close();s=openWorkspace(path);
    assert.equal(s.contacts.rooms(b).find(r=>r.id===dm.id).unread,0);
    assert.equal(s.contacts.openDirect(b,a.id).id,dm.id);
  } finally {s.close();}
});
