import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, openWorkspace } from '../server/workspace.mjs';

test('only the workspace owner provisions independently authenticated humans', () => {
  let stamp = 0;
  const ws = openWorkspace(':memory:', 'Owner', {clock:()=>stamp});
  try {
    const {human: mei,token: first} = ws.provisionHuman(ws.owner,{name:'Mei'});
    const {human: jo,token: second} = ws.provisionHuman(ws.owner,{name:'Jo'});
    assert.notEqual(first,second);
    assert.notEqual(mei.id,jo.id);
    assert.deepEqual(ws.authenticateHuman(first),mei);
    assert.deepEqual(ws.authenticateHuman(second),jo);
    assert.equal(ws.authenticateHuman('unrelated'),null);
    assert.equal(ws.authenticateAgent(first),null);
    const cookies = [ws.createHumanSession(),ws.createHumanSession(mei.id),ws.createHumanSession(jo.id)];
    assert.equal(new Set(cookies).size,3);
    assert.deepEqual(cookies.map(cookie=>ws.authenticateHumanSession(cookie)),[ws.owner,mei,jo]);
    assert.throws(()=>ws.provisionHuman(mei,{name:'No'}),{status:403});
    assert.throws(()=>ws.createRoom(mei,{name:'No'}),{status:403});
    assert.throws(()=>ws.createAgent(mei,{name:'No'}),{status:403});
    ws.revokeHumanSession(cookies[1]);
    assert.equal(ws.authenticateHumanSession(cookies[1]),null);
    assert.deepEqual(ws.authenticateHumanSession(cookies[2]),jo);
    stamp = 8*60*60*1000;
    assert.equal(ws.authenticateHumanSession(cookies[2]),null);
  } finally { ws.close(); }
});

test('group isolation, author-only persistent retract, stable thread and retry', () => {
  const directory=mkdtempSync(join(tmpdir(),'agentchat-im-'));
  const path=join(directory,'test.sqlite');
  let ws=openWorkspace(path);
  try {
    const {human: mei, token}=ws.provisionHuman(ws.owner,{name:'Mei'});
    const {human: jo}=ws.provisionHuman(ws.owner,{name:'Jo'});
    const room=ws.createRoom(ws.owner,{name:'Project'});
    assert.deepEqual(ws.listRooms(mei).map(r=>r.id),['general']);
    assert.throws(()=>ws.listMessages(mei,room.id,{}),{status:404});
    assert.throws(()=>ws.setRoomHumanMember(mei,room.id,jo.id,true),{status:403});
    assert.throws(()=>ws.setRoomHumanMember(ws.owner,room.id,ws.owner.id,false),{status:404});
    assert.deepEqual(ws.setRoomHumanMember(ws.owner,room.id,mei.id,true),{roomId:room.id,humanId:mei.id,member:true});
    const input={clientRequestId:'message',body:'ordinary text',mentions:[ws.owner.id]};
    const root=ws.send(mei,room.id,input);
    const reply=ws.send(ws.owner,room.id,{clientRequestId:'reply',body:'thread still exists',replyTo:root.id});
    assert.throws(()=>ws.retractMessage(ws.owner,room.id,root.id),{status:403});
    assert.throws(()=>ws.retractMessage(jo,room.id,root.id),{status:404});
    assert.throws(()=>ws.retractMessage(mei,'general',root.id),{status:404});
    const tombstone=ws.retractMessage(mei,room.id,root.id);
    assert.equal(tombstone.body,'');
    assert.deepEqual(tombstone.mentions,[]);
    assert.ok(tombstone.retractedAt);
    assert.deepEqual(ws.retractMessage(mei,room.id,root.id),tombstone);
    assert.deepEqual(ws.send(mei,room.id,input),tombstone);
    assert.deepEqual(ws.listMessages(ws.owner,room.id,{thread:root.id}).messages,[tombstone,reply]);
    assert.equal(ws.listReminders(ws.owner).some(item=>item.message.body===input.body),false);
    ws.close();
    ws=openWorkspace(path);
    assert.deepEqual(ws.authenticateHuman(token),mei);
    assert.deepEqual(ws.listMessages(ws.owner,room.id,{thread:root.id}).messages,[tombstone,reply]);
    ws.setRoomHumanMember(ws.owner,room.id,mei.id,false);
    assert.throws(()=>ws.retractMessage(mei,room.id,root.id),{status:404});
  } finally { ws.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('legacy owner cookies migrate to the original actor', () => {
  const directory=mkdtempSync(join(tmpdir(),'agentchat-im-legacy-'));
  const path=join(directory,'test.sqlite');
  const token='a'.repeat(43);
  try {
    const db=new DatabaseSync(path);
    db.exec('CREATE TABLE human_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    db.prepare('INSERT INTO human_sessions VALUES (?,?)').run(digest(token),60000);
    db.close();
    const ws=openWorkspace(path,'Prior Owner',{clock:()=>12345});
    try { assert.deepEqual(ws.authenticateHumanSession(token),ws.owner); }
    finally { ws.close(); }
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('attachment metadata is scoped, deduplicated and removed on retract', () => {
  const ws=openWorkspace(':memory:');
  try {
    const {human}=ws.provisionHuman(ws.owner,{name:'Reader'});
    const room=ws.createRoom(ws.owner,{name:'Private'});
    const input={clientRequestId:'attach'};
    const attachment={id:'opaque-1',name:'report.txt',mime:'text/plain',kind:'file',size:12,sha256:'a'.repeat(64)};
    assert.equal(ws.canReadRoom(human,room.id),false);
    assert.throws(()=>ws.requireRoomMember(human,room.id),{status:404});
    assert.throws(()=>ws.send(ws.owner,room.id,input),{status:400});
    assert.throws(()=>ws.send(ws.owner,room.id,input,{...attachment,name:'../report.txt'}),{status:400});
    const message=ws.send(ws.owner,room.id,input,attachment);
    assert.deepEqual(message.attachment,{id:'opaque-1',name:'report.txt',mime:'text/plain',kind:'file',size:12});
    assert.deepEqual(ws.send(ws.owner,room.id,input,{...attachment,id:'opaque-2'}),message);
    assert.throws(()=>ws.send(ws.owner,room.id,input,{...attachment,sha256:'b'.repeat(64)}),{status:409});
    assert.throws(()=>ws.getMessageAttachment(human,room.id,message.id),{status:404});
    ws.setRoomHumanMember(ws.owner,room.id,human.id,true);
    assert.equal(ws.canReadRoom(human,room.id),true);
    assert.deepEqual(ws.getMessageAttachment(human,room.id,message.id),message.attachment);
    assert.equal(ws.retractMessage(ws.owner,room.id,message.id).attachment,undefined);
    assert.equal(ws.send(ws.owner,room.id,input,attachment).attachment,undefined);
    assert.throws(()=>ws.getMessageAttachment(human,room.id,message.id),{status:404});
  } finally { ws.close(); }
});
