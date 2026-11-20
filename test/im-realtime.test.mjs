import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createImRealtime } from '../server/im-realtime.mjs';

async function fixture(t) {
  const server=createServer((_req,res)=>res.end('fixture'));
  const sessions=new Map([['human-a',{id:'a',kind:'human'}],['human-b',{id:'b',kind:'human'}]]);
  const members=new Map([['shared',new Set(['a','b'])],['private',new Set(['a'])],['control',new Set(['b'])]]);
  const realtime=createImRealtime(server,{
    authenticate:req=>sessions.get(req.headers.cookie)??null,
    allowOrigin:req=>req.headers.origin===origin,
    canReadRoom:(actor,room)=>members.get(room)?.has(actor.id)===true,
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  t.after(()=>{realtime.close(); return new Promise(resolve=>server.close(resolve));});
  function connect(cookie,options={}){
    const {path='/ws',requestOrigin=origin,extraHeaders={}}=options;
    const ws=new WebSocket(origin.replace(/^http/,'ws')+path,{headers:{cookie,...extraHeaders},origin:requestOrigin});
    ws.on('error',()=>{});
    t.after(()=>ws.terminate());
    return ws;
  }
  return {realtime,connect,members,sessions};
}

test('two authorized human sockets receive only room invalidations, with fresh access checks',{timeout:5000},async t=>{
  const f=await fixture(t);
  const a=f.connect('human-a'),b=f.connect('human-b');
  const logA=[],logB=[];
  a.on('message',msg=>logA.push(JSON.parse(String(msg))));
  b.on('message',msg=>logB.push(JSON.parse(String(msg))));
  await Promise.all([once(a,'open'),once(b,'open')]);
  const received=Promise.all([once(b,'message'),new Promise(resolve=>a.on('message',msg=>{
    if(JSON.parse(String(msg)).roomId==='shared') resolve();
  }))]);
  f.realtime.notifyRoom('private');
  f.realtime.notifyRoom('shared');
  await received;
  assert.deepEqual(logB,[{type:'room.changed',roomId:'shared'}]);
  assert.deepEqual(logA,[{type:'room.changed',roomId:'private'},{type:'room.changed',roomId:'shared'}]);
  f.members.get('shared').delete('b');
  const next=once(b,'message');
  f.realtime.notifyRoom('shared');
  f.realtime.notifyRoom('control');
  await next;
  assert.deepEqual(logB,[{type:'room.changed',roomId:'shared'},{type:'room.changed',roomId:'control'}]);
  f.sessions.delete('human-b');
  const closed=once(b,'close');
  f.realtime.notifyRoom('shared');
  await closed;
  assert.equal(logB.length,2);
});

test('upgrade requires authorized same-origin cookies and exact endpoint',{timeout:5000},async t=>{
  const f=await fixture(t);
  for (const [cookie,options,status] of [
    ['human-a',{path:'/ws?unexpected=1'},404],
    ['human-a',{requestOrigin:'https://example.invalid'},403],
    ['uncertain',{},401],
    ['human-a',{extraHeaders:{Authorization:'Bearer fixture'}},401],
  ]){
    const socket=f.connect(cookie,options);
    const [,response]=await once(socket,'unexpected-response');
    assert.equal(response.statusCode,status);
    response.resume();
  }
});

test('registered clients cannot submit application actions over the socket',{timeout:5000},async t=>{
  const f=await fixture(t);
  const socket=f.connect('human-a');
  await once(socket,'open');
  const closed=once(socket,'close');
  socket.send(JSON.stringify({type:'hello'}));
  assert.equal((await closed)[0],1008);
});
