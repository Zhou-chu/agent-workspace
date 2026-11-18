import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';

const ownerToken='workspace-artifact-fixture-owner-token';
async function fixture(t,path=':memory:') {
  const store=openWorkspace(path);
  const server=createWorkspaceServer({store,ownerToken});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  let closed=false;
  const close=async()=>{
    if(closed) return;
    closed=true;
    await new Promise(resolve=>server.close(resolve));
    store.close();
  };
  t.after(close);
  const origin='http://127.0.0.1:'+server.address().port;
  const send=(path,method,auth,payload,headers={})=>fetch(origin+path,{
    method,headers:{...auth,...headers,...(payload===undefined?{}:{'content-type':'application/json'})},
    body:payload===undefined?undefined:JSON.stringify(payload),
  });
  return {store,send,origin,close};
}
const bearer=token=>({authorization:'Bearer '+token});
const content={clientRequestId:'report-retry-1',name:'验收报告.md',kind:'markdown',text:'# 概览\n<script>alert("literal")</script>'};

test('assigned agent may publish once, room members can download as inert attachment, and restart preserves identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-artifacts-'));
  const db=join(dir,'workspace.sqlite');
  try{
    const {store,send,close}=await fixture(t,db);
    const writer=store.createAgent(store.owner,{name:'Writer'});
    const reader=store.createAgent(store.owner,{name:'Reader'});
    const task=store.createTask(store.owner,{roomId:'general',title:'Review',assigneeId:writer.agent.id});
    const path='/api/tasks/'+task.id+'/artifacts';
    assert.equal((await send(path,'GET',{})).status,401);
    assert.equal((await send(path,'POST',bearer(reader.token),content)).status,403);
    const [first,retry]=await Promise.all([1,2].map(()=>send(path,'POST',bearer(writer.token),content)));
    assert.equal(first.status,201);
    assert.equal(retry.status,201);
    const {artifact}=await first.json();
    assert.deepEqual((await retry.json()).artifact,artifact);
    assert.deepEqual(Object.keys(artifact).sort(),['authorId','bytes','createdAt','id','kind','name','taskId']);
    assert.equal(artifact.authorId,writer.agent.id);
    assert.equal(artifact.taskId,task.id);
    assert.equal(artifact.bytes,Buffer.byteLength(content.text));
    assert.equal((await send(path,'POST',bearer(writer.token),{...content,text:'different'})).status,409);
    const listed=await send(path,'GET',bearer(reader.token));
    assert.deepEqual(await listed.json(),{artifacts:[artifact]});
    const direct=path+'/'+artifact.id;
    assert.equal((await send(direct,'GET',{})).status,401);
    const download=await send(direct,'GET',bearer(reader.token));
    assert.equal(download.headers.get('Content-Type'),'text/plain; charset=utf-8');
    assert.equal(download.headers.get('X-Content-Type-Options'),'nosniff');
    assert.equal(download.headers.get('Cache-Control'),'no-store');
    assert.match(download.headers.get('Content-Disposition'),/^attachment; .*filename\*=UTF-8''/);
    assert.equal(await download.text(),content.text);
    const head=await send(direct,'HEAD',bearer(reader.token));
    assert.equal(head.status,200);
    assert.equal(head.headers.get('Content-Length'),String(artifact.bytes));
    assert.equal(await head.text(),'');
    store.setRoomMember(store.owner,'general',reader.agent.id,false);
    assert.equal((await send(path,'GET',bearer(reader.token))).status,404);
    assert.equal((await send(direct,'GET',bearer(reader.token))).status,404);
    store.setAgentEnabled(store.owner,writer.agent.id,false);
    assert.equal((await send(path,'POST',bearer(writer.token),content)).status,401);
    await close();
    const again=await fixture(t,db);
    try{
      assert.deepEqual(await (await again.send(path,'GET',bearer(ownerToken))).json(),{artifacts:[artifact]});
      assert.equal(await (await again.send(direct,'GET',bearer(ownerToken))).text(),content.text);
    }finally{await again.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('artifact paths, origin, payload size, and task/room isolation are enforced',async t=>{
  const {store,send,origin}=await fixture(t);
  const writer=store.createAgent(store.owner,{name:'Writer'});
  const alpha=store.createRoom(store.owner,{name:'Private'});
  const task=store.createTask(store.owner,{roomId:alpha.id,title:'Result'});
  const other=store.createTask(store.owner,{roomId:'general',title:'Other',assigneeId:writer.agent.id});
  const path='/api/tasks/'+task.id+'/artifacts';
  const general='/api/tasks/'+other.id+'/artifacts';
  const browser=await send('/api/login','POST',{}, {token:ownerToken},{origin});
  const cookie=browser.headers.get('set-cookie').split(';')[0];
  assert.equal((await send(path,'POST',{cookie},content,{origin:'https://example.invalid'})).status,403);
  assert.equal((await send(path,'POST',bearer(writer.token),content)).status,404);
  for(const input of [
    {...content,name:'../result.md'}, {...content,name:'file.html'}, {...content,name:'a\r\nInjected.md'},
    {...content,kind:'html'}, {...content,text:'\0x'}, {...content,clientRequestId:'not safe'},
    {...content,authorId:writer.agent.id}, {...content,taskId:other.id},
  ]) assert.equal((await send(path,'POST',{cookie},input,{origin})).status,400);
  assert.equal((await send(path,'POST',{cookie},{...content,text:'界'.repeat(8193)},{origin})).status,413);
  const result=await send(path,'POST',{cookie},content,{origin});
  assert.equal(result.status,201);
  const {artifact}=await result.json();
  assert.equal(artifact.authorId,'owner');
  assert.equal((await send(path+'/'+artifact.id,'GET',bearer(writer.token))).status,404);
  assert.equal((await send(general+'/'+artifact.id,'GET',{cookie})).status,404);
  assert.equal((await send('/artifacts/'+artifact.id,'GET',{})).status,404);
  const download=await send(path+'/'+artifact.id,'GET',{cookie});
  assert.equal(download.status,200);
  assert.equal(await download.text(),content.text);
});

test('artifact limits and closed task rules retain exact retry semantics',async t=>{
  const {store,send}=await fixture(t);
  const writer=store.createAgent(store.owner,{name:'Writer'});
  const task=store.createTask(store.owner,{roomId:'general',title:'Result',assigneeId:writer.agent.id});
  const path='/api/tasks/'+task.id+'/artifacts';
  const fullSize={clientRequestId:'full-size',name:'report.txt',kind:'text',text:'x'.repeat(24*1024)};
  const created=await send(path,'POST',bearer(writer.token),fullSize);
  assert.equal(created.status,201);
  const {artifact}=await created.json();
  assert.equal(artifact.bytes,24576);
  store.updateTask(store.owner,task.id,{status:'cancelled',expectedVersion:1});
  const replay=await send(path,'POST',bearer(writer.token),fullSize);
  assert.equal(replay.status,201);
  assert.deepEqual((await replay.json()).artifact,artifact);
  assert.equal((await send(path,'POST',bearer(writer.token),{...fullSize,clientRequestId:'new'})).status,409);
  for(let i=1;i<20;i++){
    const added=await send(path,'POST',bearer(ownerToken),{...content,clientRequestId:'result-'+i});
    assert.equal(added.status,201);
    await added.json();
  }
  assert.equal((await send(path,'POST',bearer(ownerToken),content)).status,409);
  const listed=await send(path,'GET',bearer(ownerToken));
  assert.equal((await listed.json()).artifacts.length,20);
});
