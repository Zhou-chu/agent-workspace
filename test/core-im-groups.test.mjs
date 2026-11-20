import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWorkspace } from '../server/workspace.mjs';

test('managed human group admission, role hierarchy, history and announcements',t=>{
  const store=openWorkspace(':memory:');
  t.after(()=>store.close());
  const globalOwner=store.owner, g=store.groups;
  const user=name=>store.provisionHuman(globalOwner,{name}).human;
  const alice=user('Alice'), bob=user('Bob'), cara=user('Cara'), danny=user('Danny');
  const friend=(a,b)=>{store.contacts.request(a,b.id); store.contacts.accept(b,a.id);};
  friend(alice,bob); friend(bob,cara); friend(bob,danny);
  const reject=(fn,status)=>assert.throws(fn,e=>e.status===status);
  const room=g.create(alice,{name:' Team '});
  assert.deepEqual(room,{id:room.id,name:'Team',kind:'group',managed:true,unread:0});
  assert.equal(store.contacts.rooms(alice).find(r=>r.id===room.id).managed,true);
  reject(()=>g.detail(globalOwner,room.id),404);
  reject(()=>g.detail(alice,'general'),404);
  reject(()=>g.invite(alice,room.id,cara.id),404);
  const initial=g.invite(alice,room.id,bob.id).invite;
  assert.equal(initial.status,'pending_acceptance');
  assert.equal(g.invite(alice,room.id,bob.id).invite.id,initial.id);
  assert.deepEqual(g.personalInvites(bob).map(x=>x.id),[initial.id]);
  reject(()=>g.announcements(bob,room.id),404);
  const announcement=g.announce(alice,room.id,{text:'Opening note'});
  g.decide(bob,room.id,initial.id,'accept');
  assert.equal(g.decide(bob,room.id,initial.id,'accept').changed,false);
  assert.deepEqual(g.announcements(bob,room.id),[announcement]);
  reject(()=>g.announce(bob,room.id,{text:'Unauthorized'}),403);
  const waiting=g.invite(bob,room.id,cara.id).invite;
  assert.equal(waiting.status,'pending_review');
  assert.deepEqual(g.personalInvites(cara),[]);
  reject(()=>g.decide(cara,room.id,waiting.id,'accept'),404);
  reject(()=>g.decide(bob,room.id,waiting.id,'approve'),403);
  g.decide(alice,room.id,waiting.id,'approve');
  assert.equal(g.personalInvites(cara)[0].status,'pending_acceptance');
  assert.equal(store.canReadRoom(cara,room.id),false);
  g.decide(cara,room.id,waiting.id,'accept');
  assert.equal(store.canReadRoom(cara,room.id),true);
  g.member(alice,room.id,bob.id,'promote');
  assert.equal(g.detail(bob,room.id).role,'admin');
  reject(()=>g.member(bob,room.id,cara.id,'promote'),403);
  reject(()=>g.member(bob,room.id,alice.id,'remove'),403);
  const stale=g.invite(bob,room.id,danny.id).invite;
  reject(()=>g.leave(alice,room.id),409);
  g.member(alice,room.id,bob.id,'transfer');
  assert.equal(g.detail(bob,room.id).role,'owner');
  assert.equal(g.detail(alice,room.id).role,'member');
  reject(()=>g.groupInvites(alice,room.id),403);
  reject(()=>g.member(alice,room.id,cara.id,'transfer'),403);
  g.leave(alice,room.id);
  assert.equal(store.canReadRoom(alice,room.id),false);
  g.member(bob,room.id,cara.id,'remove');
  assert.equal(store.canReadRoom(cara,room.id),false);
  assert.equal(g.decide(cara,room.id,waiting.id,'accept').changed,false);
  assert.equal(store.canReadRoom(cara,room.id),false);
  assert.equal(g.decide(danny,room.id,stale.id,'decline').invite.status,'declined');
});

test('managed group roles survive restart and existing legacy memberships are unaffected',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {DatabaseSync}=await import('node:sqlite');
  const dir=await mkdtemp(join(tmpdir(),'agentchat-group-'));
  const file=join(dir,'workspace.sqlite');
  let first, second;
  t.after(async()=>{first?.close(); second?.close(); await rm(dir,{recursive:true,force:true});});
  first=openWorkspace(file);
  const owner=first.owner;
  const bob=first.provisionHuman(owner,{name:'Bob'}).human;
  const cara=first.provisionHuman(owner,{name:'Cara'}).human;
  const legacy=first.createRoom(owner,{name:'Legacy'});
  first.setRoomHumanMember(owner,legacy.id,bob.id,true);
  first.contacts.request(owner,bob.id);
  first.contacts.accept(bob,owner.id);
  const managed=first.groups.create(owner,{name:'New'});
  const invite=first.groups.invite(owner,managed.id,bob.id).invite;
  first.groups.decide(bob,managed.id,invite.id,'accept');
  first.groups.member(owner,managed.id,bob.id,'transfer');
  first.close();
  first=undefined;

  second=openWorkspace(file);
  assert.equal(second.groups.detail(bob,managed.id).role,'owner');
  assert.equal(second.groups.detail(owner,managed.id).role,'member');
  assert.equal(second.groups.personalInvites(bob)[0].status,'accepted');
  assert.equal(second.canReadRoom(bob,legacy.id),true);
  assert.deepEqual(second.listRooms(owner).map(r=>r.name),['General','Legacy']);
  assert.throws(()=>second.setRoomHumanMember(owner,managed.id,cara.id,true),e=>e.status===409);

  // A former build still using the shared members table cannot alter managed membership.
  const older=new DatabaseSync(file);
  try {
    older.exec('PRAGMA foreign_keys=ON');
    assert.throws(()=>older.prepare('INSERT INTO members VALUES (?,?)').run(managed.id,cara.id),/Managed membership requires admission/);
    assert.throws(()=>older.prepare('DELETE FROM members WHERE room_id=? AND actor_id=?').run(managed.id,bob.id),/Use managed membership/);
    assert.throws(()=>older.prepare('UPDATE members SET actor_id=? WHERE room_id=? AND actor_id=?').run(cara.id,managed.id,bob.id),/Use managed membership/);
  } finally {
    older.close();
  }
});
