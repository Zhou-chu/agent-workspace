import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';
import { createImRealtime } from '../server/im-realtime.mjs';

test('managed group HTTP, websocket visibility and immediate member revocation',{timeout:7000},async t=>{
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
  async function call(path,cookie,body,method=body===undefined?'GET':'POST',authorization) {
    const headers={Origin:origin,...(cookie?{Cookie:cookie}:{}),...(authorization?{Authorization:authorization}:{})};
    if(body!==undefined) headers['Content-Type']='application/json';
    const r=await fetch(origin+path,{method,headers,body:JSON.stringify(body)});
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
    function waitFor(type){
      return new Promise(resolve=>{
        function onMessage(wire){
          const event=JSON.parse(String(wire));
          if(event.type!==type) return;
          socket.off('message',onMessage);
          resolve(event);
        }
        socket.on('message',onMessage);
      });
    }
    return {socket,events,waitFor};
  }

  const a=await login('Alice'),b=await login('Bob'),c=await login('Cara'),o=await login();
  const [wa,wb,wc,wo]=await Promise.all([a,b,c,o].map(connect));
  await call('/api/contacts/request',a.cookie,{humanId:b.id});
  await call('/api/contacts/accept',b.cookie,{humanId:a.id});
  assert.equal((await call('/api/session',a.cookie))[1].managedGroups,true);
  const base='/api/im/groups', inbox='/api/im/group-invites';
  assert.equal((await call(base,null,{name:'Manager impersonation'},'POST','Bearer '+token))[0],403);
  const [code,data]=await call(base,a.cookie,{name:'Study Team'});
  assert.equal(code,201);
  const id=data.room.id, group=base+'/'+id, old='/api/rooms/'+id;
  assert.equal((await call(group,a.cookie))[1].role,'owner');
  assert.equal((await call(old+'/messages',o.cookie))[0],404);
  assert.equal((await call(old+'/messages',a.cookie,{clientRequestId:'opening',body:'Persisted detail'}))[0],201);
  const receiveInvite=once(wb.socket,'message');
  const [created,result]=await call(group+'/invites',a.cookie,{userId:b.id});
  assert.equal(created,201);
  await receiveInvite;
  assert.deepEqual(wb.events.at(-1),{type:'group-invites.changed'});
  assert.equal((await call(inbox,b.cookie))[1].invites[0].id,result.invite.id);
  assert.equal((await call(old+'/messages',b.cookie))[0],404);
  const decision=group+'/invites/'+result.invite.id;
  assert.equal((await call(decision,b.cookie,{action:'accept'},'PATCH'))[0],200);
  assert.equal((await call(old+'/messages',b.cookie))[1].messages[0].body,'Persisted detail');
  await call('/api/contacts/request',b.cookie,{humanId:c.id});
  await call('/api/contacts/accept',c.cookie,{humanId:b.id});
  const review=wa.waitFor('group-invites.changed');
  assert.equal((await call(group+'/invites',b.cookie,{userId:c.id}))[0],201);
  assert.deepEqual(await review,{type:'group-invites.changed'});
  assert.deepEqual((await call(inbox,c.cookie))[1],{invites:[]});
  assert.deepEqual(wc.events.map(e=>e.type),['contacts.changed','contacts.changed']);
  const removed=wb.waitFor('group-membership.changed');
  assert.equal((await call(group+'/members/'+b.id,a.cookie,{action:'remove'},'PATCH'))[0],200);
  assert.deepEqual(await removed,{type:'group-membership.changed',roomId:id});
  assert.equal((await call(old+'/messages',b.cookie))[0],404);
  assert.deepEqual((await call(inbox,c.cookie))[1],{invites:[]});
  const controls=Promise.all([wa,wb,wo].map(socket=>socket.waitFor('room.changed')));
  await call('/api/rooms/general/messages',o.cookie,{clientRequestId:'control',body:'General checkpoint'});
  await controls;
  assert.deepEqual(wo.events,[{type:'room.changed',roomId:'general'}]);
  assert.equal(wb.events.filter(e=>e.type==='room.changed'&&e.roomId===id).length,1);
});
