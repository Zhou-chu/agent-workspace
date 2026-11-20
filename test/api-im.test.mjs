import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';
import { createImRealtime } from '../server/im-realtime.mjs';
import { localImStorage } from '../server/im-attachments.mjs';

test('independent IM API: scoped human sessions, durable chat, stored media and retractions', {timeout:7000}, async t=>{
  const data=await mkdtemp(join(tmpdir(),'agentchat-api-im-'));
  const store=openWorkspace(join(data,'workspace.sqlite'),'Alice');
  const key=randomBytes(32).toString('hex');
  const objects=localImStorage(join(data,'objects'));
  const server=createWorkspaceServer({store,ownerToken:key,webDir:null,imObjects:objects,createRealtime:createImRealtime});
  const sockets=[];
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{
    sockets.forEach(socket=>socket.terminate());
    server.stopImRealtime();
    await new Promise(resolve=>server.close(resolve));
    store.close();
    await rm(data,{recursive:true,force:true});
  });
  const origin='http://127.0.0.1:'+server.address().port;
  async function request(path,{token,method='GET',body,media}={}) {
    const headers={Origin:origin,...(token?{Cookie:token}: {})};
    if(media) Object.assign(headers,media);
    else if(body!==undefined){
      headers['Content-Type']='application/json';
      body=JSON.stringify(body);
    }
    return fetch(origin+path,{method,headers,body});
  }
  const post=(path,token,body)=>request(path,{token,method:'POST',body});
  const json=async (response,status)=>{
    assert.equal(response.status,status);
    return response.json();
  };
  async function login(credential) {
    const response=await post('/api/login',null,{token:credential});
    const payload=await json(response,200);
    return {...payload,session:response.headers.get('set-cookie').split(';')[0]};
  }
  assert.equal((await request('/')).status,404);
  const alice=await login(key);
  const invite=await json(await post('/api/humans',alice.session,{name:'Bob'}),201);
  const bob=await login(invite.token);
  assert.notEqual(alice.user.id,bob.user.id);
  assert.notEqual(alice.session,bob.session);
  assert.equal((await json(await request('/api/session',{token:bob.session}),200)).user.name,'Bob');
  assert.equal((await post('/api/humans',bob.session,{name:'Other'})).status,403);
  const room='/api/rooms/general';
  const socket=new WebSocket(origin.replace('http:','ws:')+'/ws',{origin,headers:{Cookie:bob.session}});
  sockets.push(socket);
  await once(socket,'open');
  const notification=once(socket,'message');
  const sent=(await json(await post(room+'/messages',alice.session,{clientRequestId:'text',body:'Hello'}),201)).message;
  assert.deepEqual(JSON.parse(String((await notification)[0])),{type:'room.changed',roomId:'general'});
  assert.equal(sent.authorName,'Alice');
  assert.equal((await post(room+'/messages/'+sent.id+'/retract',bob.session,{})).status,403);
  assert.ok((await json(await post(room+'/messages/'+sent.id+'/retract',alice.session,{}),200)).message.retractedAt);
  const tombstone=(await json(await request(room+'/messages',{token:bob.session}),200)).messages[0];
  assert.equal(tombstone.body,'');
  assert.equal(tombstone.id,sent.id);
  assert.ok(tombstone.retractedAt);

  const bytes=Buffer.from('local storage verification');
  const media={'Content-Type':'text/plain','X-AgentChat-Media-Kind':'file','X-AgentChat-File-Name':'file.txt','X-AgentChat-Request-Id':'file'};
  async function sendFile() {
    const response=await request(room+'/attachments',{token:alice.session,method:'POST',body:bytes,media});
    return (await json(response,201)).message;
  }
  const entry=await sendFile();
  assert.equal((await sendFile()).id,entry.id);
  const href=room+'/messages/'+entry.id+'/attachment';
  assert.equal((await request(href)).status,401);
  const downloaded=await request(href,{token:bob.session});
  assert.equal(downloaded.status,200);
  assert.match(downloaded.headers.get('content-disposition'),/^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
  assert.deepEqual(await objects.get(entry.attachment.id),bytes);
  assert.equal((await post(room+'/messages/'+entry.id+'/retract',alice.session,{})).status,200);
  assert.equal((await request(href,{token:bob.session})).status,404);
  assert.equal(await objects.get(entry.attachment.id),null);
});
