import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';
import { createImRealtime } from '../server/im-realtime.mjs';

test('modern human contact HTTP and websocket events remain scoped to authorized participants',{timeout:7000},async t=>{
  const store=openWorkspace(':memory:','Owner');
  const token=randomBytes(32).toString('hex');
  const server=createWorkspaceServer({store,ownerToken:token,webDir:null,imObjects:{},createRealtime:createImRealtime});
  const sockets=[];
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{
    for(const ws of sockets) ws.terminate();
    server.stopImRealtime();
    await new Promise(resolve=>server.close(resolve));
    store.close();
  });
  const origin='http://127.0.0.1:'+server.address().port;
  async function call(path,cookie,body) {
    const headers={Origin:origin,...(cookie?{Cookie:cookie}:{})};
    if(body!==undefined) headers['Content-Type']='application/json';
    const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers,body:JSON.stringify(body)});
    return [r.status,await r.json(),r.headers.get('set-cookie')?.split(';')[0]];
  }
  async function login(name){
    const actor=name?store.provisionHuman(store.owner,{name}):{human:store.owner,token};
    const [code,,cookie]=await call('/api/login',null,{token:actor.token});
    assert.equal(code,200);
    return {id:actor.human.id,cookie};
  }
  async function connect({cookie}){
    const socket=new WebSocket(origin.replace('http:','ws:')+'/ws',{origin,headers:{Cookie:cookie}});
    sockets.push(socket);
    const events=[];
    socket.on('message',wire=>events.push(JSON.parse(String(wire))));
    await once(socket,'open');
    return {socket,events};
  }
  const a=await login('Alice'),b=await login('Bob'),o=await login();
  const [wa,wb,wo]=await Promise.all([a,b,o].map(connect));
  const search=await call('/api/contacts/search?q=bo',a.cookie);
  assert.equal(search[0],200);
  assert.deepEqual(search[1],{people:[{id:b.id,name:'Bob',status:'none'}]});
  const requested=once(wb.socket,'message');
  const [requestCode,request]=await call('/api/contacts/request',a.cookie,{humanId:b.id});
  assert.equal(requestCode,200);
  assert.deepEqual(request.person,{id:b.id,name:'Bob',status:'outgoing'});
  await requested;
  assert.deepEqual(wb.events.at(-1),{type:'contacts.changed'});
  const accepted=once(wa.socket,'message');
  assert.equal((await call('/api/contacts/accept',b.cookie,{humanId:a.id}))[0],200);
  await accepted;
  assert.deepEqual((await call('/api/contacts',a.cookie))[1].friends,[{id:b.id,name:'Bob'}]);
  const added=once(wb.socket,'message');
  const [opened,detail]=await call('/api/direct',a.cookie,{humanId:b.id});
  assert.equal(opened,200);
  const room=detail.room.id;
  await added;
  assert.deepEqual(wb.events.at(-1),{type:'room.changed',roomId:room});
  const path='/api/rooms/'+room;
  assert.equal((await call(path+'/messages',o.cookie))[0],404);
  const sent=once(wb.socket,'message');
  assert.equal((await call(path+'/messages',a.cookie,{clientRequestId:'sample',body:'Bonjour'}))[0],201);
  await sent;
  const unread=(await call('/api/rooms',b.cookie))[1].rooms.find(r=>r.id===room);
  assert.deepEqual(unread,{id:room,name:'Alice',kind:'direct',peer:{id:a.id,name:'Alice'},unread:1});
  const cursor=(await call(path+'/messages',b.cookie))[1].nextCursor;
  const advanced=once(wb.socket,'message');
  assert.deepEqual((await call(path+'/read',b.cookie,{cursor}))[1],{roomId:room,cursor,unread:0});
  await advanced;
  assert.deepEqual(wb.events.at(-1),{type:'read.changed',roomId:room});
  const next=Promise.all([wa,wb,wo].map(({socket})=>once(socket,'message')));
  assert.deepEqual((await call(path+'/read',b.cookie,{cursor}))[1],{roomId:room,cursor,unread:0});
  await call('/api/rooms/general/messages',o.cookie,{clientRequestId:'control',body:'Normal group control'});
  await next;
  assert.deepEqual(wb.events.filter(ev=>ev.type==='read.changed'),[{type:'read.changed',roomId:room}]);
  assert.equal(wa.events.filter(ev=>ev.type==='read.changed').length,0);
  assert.deepEqual(wo.events,[{type:'room.changed',roomId:'general'}]);
});
