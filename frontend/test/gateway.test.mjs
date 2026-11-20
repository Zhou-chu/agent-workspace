import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontend } from '../build.mjs';
import { createFrontendServer } from '../gateway/index.mjs';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  return 'http://127.0.0.1:'+server.address().port;
}

test('frontend serves dist and proxies only API traffic to the configured origin', async t=>{
  const received=[];
  const backend=await listen(t,createServer(async (req,res)=>{
    let body='';
    for await (const chunk of req) body+=chunk;
    received.push({ path:req.url, method:req.method, host:req.headers.host, origin:req.headers.origin, cookie:req.headers.cookie, body });
    res.writeHead(201,{'Set-Cookie':['first=one; Path=/','second=two; Path=/']});
    res.end('accepted');
  }));
  const distDir=await mkdtemp(join(tmpdir(),'agentchat-gateway-'));
  t.after(()=>rm(distDir,{force:true,recursive:true}));
  await buildFrontend(distDir);
  const address=await listen(t,await createFrontendServer({ backendOrigin:backend, distDir }));
  const publicPage=await fetch(address);
  assert.match(await publicPage.text(),/<title>AgentChat<\/title>/);
  assert.equal((await fetch(address+'/styles.css',{method:'HEAD'})).status,200);
  assert.equal((await fetch(address+'/healthz')).status,200);
  assert.equal((await fetch(address+'/gateway/index.mjs')).status,404);
  assert.deepEqual(received,[]);
  const answer=await fetch(address+'/api/probe?page=2',{method:'POST',body:'ordinary payload',headers:{Origin:address,Cookie:'sid=sample'}});
  assert.equal(answer.status,201);
  assert.equal(await answer.text(),'accepted');
  assert.deepEqual(answer.headers.getSetCookie(),['first=one; Path=/','second=two; Path=/']);
  assert.deepEqual(received,[{path:'/api/probe?page=2',method:'POST',host:new URL(address).host,origin:address,cookie:'sid=sample',body:'ordinary payload'}]);
});

test('frontend relays an ordinary WebSocket handshake and backend text frame', async t=>{
  const sockets=new Set();
  const backendServer=createServer();
  backendServer.on('upgrade',(req,socket)=>{
    sockets.add(socket);
    socket.once('close',()=>sockets.delete(socket));
    assert.equal(req.url,'/ws');
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    socket.write(Buffer.from([129,2,111,107]));
  });
  const backend=await listen(t,backendServer);
  const distDir=await mkdtemp(join(tmpdir(),'agentchat-ws-'));
  await buildFrontend(distDir);
  const frontend=await createFrontendServer({ backendOrigin:backend, distDir });
  const address=await listen(t,frontend);
  const client=new WebSocket(address.replace('http:', 'ws:')+'/ws');
  try {
    const [event]=await once(client,'message',{signal:AbortSignal.timeout(3500)});
    assert.equal(event.data,'ok');
  } finally {
    client.close();
    for(const socket of sockets) socket.destroy();
    await rm(distDir,{force:true,recursive:true});
  }
});

test('startup refuses missing dist or a non-loopback backend origin', async ()=>{
  await assert.rejects(createFrontendServer({backendOrigin:'http://127.0.0.1:4319',distDir:'/does-not-exist-agentchat-dist'}),/frontend build/i);
  await assert.rejects(createFrontendServer({backendOrigin:'http://192.0.2.1:4319'}),/loopback/i);
});

test('gateway validates API paths, canonically encodes queries and does not forward noncanonical WebSocket paths', async t=>{
  const received=[];
  const backendServer=createServer((req,res)=>{
    received.push(req.url);
    res.end('received');
  });
  backendServer.on('upgrade',(req,socket)=>{ received.push(req.url); socket.destroy(); });
  const backend=await listen(t,backendServer);
  const distDir=await mkdtemp(join(tmpdir(),'agentchat-gateway-target-'));
  t.after(()=>rm(distDir,{force:true,recursive:true}));
  await buildFrontend(distDir);
  const address=await listen(t,await createFrontendServer({backendOrigin:backend,distDir}));
  const query=await fetch(address+'/api/rooms/chat/messages?after=7&label=one%20two&label=three');
  assert.equal(query.status,200);
  await query.text();
  assert.equal((await fetch(address+'/api/room_name')).status,400);
  const client=new WebSocket(address.replace('http:','ws:')+'/ws?version=1');
  await once(client,'error',{signal:AbortSignal.timeout(3000)});
  assert.deepEqual(received,['/api/rooms/chat/messages?after=7&label=one%20two&label=three']);
});

test('frontend remains available when its approved loopback backend is unavailable', async t=>{
  const origin=await listen(t,createServer(req=>req.socket.destroy()));
  const distDir=await mkdtemp(join(tmpdir(),'agentchat-gateway-unavailable-'));
  t.after(()=>rm(distDir,{force:true,recursive:true}));
  await buildFrontend(distDir);
  const address=await listen(t,await createFrontendServer({backendOrigin:origin,distDir}));
  assert.equal((await fetch(address+'/healthz')).status,200);
  assert.equal((await fetch(address+'/api/rooms')).status,502);
});
