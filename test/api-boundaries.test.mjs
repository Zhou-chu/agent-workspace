import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createWorkspaceServer} from '../server/index.mjs';
import {openWorkspace} from '../server/workspace.mjs';

const ownerToken='local-fixture-dedicated-owner-token-001';
async function fixture(t,options={}) {
  const store=openWorkspace(':memory:');
  const server=createWorkspaceServer({store,ownerToken,...options});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const fetchLocal=(path,init)=>fetch(origin+path,init);
  async function api(path,{method='GET',payload,token=ownerToken,status=200}={}) {
    const headers={};
    if (token) headers.Authorization='Bearer '+token;
    if (payload!==undefined) headers['Content-Type']='application/json';
    const response=await fetchLocal('/api'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)});
    const value=await response.json();
    assert.equal(response.status,status,path+': '+JSON.stringify(value));
    return value;
  }
  return {api,fetchLocal,origin};
}

test('real routes enforce room boundaries, one-level threading, and decision authority',async t=>{
  const {api}=await fixture(t);
  const post=(path,payload,options)=>api(path,{method:'POST',status:201,payload,...options});
  const {agents}=await api('/agents');
  assert.deepEqual(agents,[]);
  const {agent:a,token}=await post('/agents',{name:'In-room'});
  const {agent:b,token:other}=await post('/agents',{name:'Other room'});
  const {room}=await post('/rooms',{name:'Private project'});
  const root='/rooms/'+room.id, member=root+'/members', messages=root+'/messages';
  await api(member,{token,status:404});
  await post(member,{agentId:a.id,member:true},{status:403,token});
  await post(member,{agentId:a.id,member:true},{status:200});
  assert.deepEqual((await api(member,{token})).members.map(x=>x.id).sort(),[a.id,'owner'].sort());
  await api(messages,{token:other,status:404});
  await post(messages,{clientRequestId:'wrong',body:'hello',mentions:[b.id]},{status:400});
  const {message:m}=await post(messages,{clientRequestId:'root',body:'context'});
  const {message:reply}=await post(messages,{clientRequestId:'reply',body:'ask owner',replyTo:m.id,mentions:['owner']},{token});
  await post(messages,{clientRequestId:'nested',body:'nested',replyTo:reply.id},{status:400});
  await api(messages+'?thread='+reply.id,{status:404});
  await api(messages+'?limit=0',{token,status:400});
  await api(messages+'?consumer=session-a',{status:400});
  const page=await api(messages+'?thread='+m.id+'&consumer=session-a&limit=1',{token});
  assert.deepEqual(page.messages.map(x=>x.id),[m.id]);
  assert.equal(page.hasMore,true);
  const later=await api(messages+'?thread='+m.id+'&consumer=session-a',{token});
  assert.deepEqual(later.messages.map(x=>x.id),[reply.id]);
  assert.equal((await api('/reminders')).reminders[0].status,'notification');
  const {task}=await post('/tasks',{roomId:room.id,title:'Review evidence',assigneeId:a.id});
  assert.deepEqual((await api('/tasks',{token:other})).tasks,[]);
  assert.deepEqual((await api('/tasks',{token})).tasks.map(x=>x.id),[task.id]);
  const method='PATCH';
  await api('/tasks/'+task.id,{method,payload:{status:'in_progress',expectedVersion:0},status:400});
  const {task:started}=await api('/tasks/'+task.id,{method,payload:{status:'in_progress',expectedVersion:task.version},token});
  await api('/tasks/'+task.id,{method,payload:{status:'in_progress',expectedVersion:started.version},token});
  await api('/tasks/'+task.id,{method,payload:{status:'open',expectedVersion:started.version},status:409});
  await post('/decisions',{roomId:room.id,question:'Check?',options:['yes','yes']},{token,status:400});
  const {decision}=await post('/decisions',{roomId:room.id,taskRef:task.id,question:'Accept this?',options:['Yes','No']},{token});
  assert.deepEqual((await api('/decisions',{token:other})).decisions,[]);
  assert.deepEqual((await api('/decisions',{token})).decisions.map(x=>x.id),[decision.id]);
  const resolve='/decisions/'+decision.id+'/resolve';
  await post(resolve,{response:'Yes'},{status:403,token});
  await post(resolve,{response:'Maybe'},{status:400});
  assert.equal((await post(resolve,{response:'Yes'},{status:200})).decision.status,'resolved');
  await post('/agents/'+a.id+'/enabled',{enabled:false},{status:200});
  await api('/session',{token,status:401});
});

test('authentication rejects invalid origin and body; bounded rate limit cannot create a session',async t=>{
  const publicOrigin='https://agent-workspace.example';
  const {fetchLocal}=await fixture(t,{publicOrigin,secureCookies:true});
  const login=(body,{origin=publicOrigin,contentType='application/json',...extra}={})=>fetchLocal('/api/login',{
    method:'POST',headers:{origin,'Content-Type':contentType},body,...extra,
  });
  let response=await login(JSON.stringify({token:ownerToken}),{origin:'https://unrelated.example'});
  assert.equal(response.status,403);
  response=await login('{');
  assert.equal(response.status,400);
  response=await login('[]');
  assert.equal(response.status,400);
  response=await login('{}',{contentType:'text/plain'});
  assert.equal(response.status,415);
  response=await login(JSON.stringify({test:'x'.repeat(97*1024)}));
  assert.equal(response.status,413);
  const streamed=new ReadableStream({
    start(controller) {
      const segment=new TextEncoder().encode(' '.repeat(48*1024+1));
      controller.enqueue(segment); controller.enqueue(segment); controller.close();
    },
  });
  response=await login(streamed,{duplex:'half'});
  assert.equal(response.status,413);
  response=await login(JSON.stringify({token:ownerToken}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/; Secure/);
  for(let i=0;i<12;i++){
    response=await login(JSON.stringify({token:'incorrect-fixture'}));
    assert.equal(response.status,401);
    assert.equal(response.headers.get('set-cookie'),null);
    await response.json();
  }
  response=await login(JSON.stringify({token:ownerToken}));
  assert.equal(response.status,429);
  assert.equal(response.headers.get('set-cookie'),null);
});

test('static handler allows known assets, denies private and unrecognized content, and supports HEAD',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-assets-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const content='<main>Fixture</main>';
  await writeFile(join(dir,'index.html'),content);
  await writeFile(join(dir,'script.mjs'),'export {};');
  await writeFile(join(dir,'notes.txt'),'not a published asset');
  await writeFile(join(dir,'.hidden.mjs'),'not a published asset');
  const {fetchLocal}=await fixture(t,{webDir:dir});
  let response=await fetchLocal('/');
  assert.equal(response.headers.get('content-type'),'text/html; charset=utf-8');
  assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(await response.text(),content);
  response=await fetchLocal('/script.mjs',{method:'HEAD'});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-length'),String(Buffer.byteLength('export {};')));
  assert.equal(await response.text(),'');
  for(const path of ['/notes.txt','/.hidden.mjs','/missing.css']){
    assert.equal((await fetchLocal(path)).status,404,path);
  }
  assert.equal((await fetchLocal('/',{method:'POST'})).status,405);
});

test('server construction rejects missing owner secrets or ambiguous proxy origins',()=>{
  assert.throws(()=>createWorkspaceServer({ownerToken:'short'}),/WORKSPACE_TOKEN/);
  assert.throws(()=>createWorkspaceServer({ownerToken,publicOrigin:'https://agent-workspace.example/path'}),/WORKSPACE_PUBLIC_ORIGIN/);
});
