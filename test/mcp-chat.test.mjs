import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChatBridge, serveStdio } from '../connector/mcp-chat.mjs';

const origin='http://127.0.0.1:4319';
const agent='aw_agent_'+'a'.repeat(43);
const options={baseUrl:origin,token:agent,consumerId:'one'};
const tool=(name,args)=>({name,arguments:args});
const data=result=>JSON.parse(result.content[0].text);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const message={id:'m1',roomId:'general',authorId:'agent-1',authorName:'A',authorKind:'agent',body:'Hello',mentions:[],replyTo:null,taskRef:null,createdAt:new Date(0).toISOString()};

test('bridge allows only typed workspace endpoints, never forwards secrets or redirects, and requires a stable mutation ID',async()=>{
  const requests=[];
  const bridge=createChatBridge({...options,fetchImpl:async (url,init)=>{
    requests.push([new URL(url),init]);
    return url.includes('?')
      ? json({messages:[{...message,hiddenTrace:'not forwarded'}],nextCursor:'1',hasMore:false,debug:'not forwarded'})
      : json({message:{...message,body:'literal @B',hiddenTrace:'not forwarded'}});
  }});
  for (const config of [{baseUrl:'http://localhost:4319'},{baseUrl:'http://192.0.2.1/'},{baseUrl:'https://x.invalid/path'},{baseUrl:'https://x.invalid/?q=1'},{baseUrl:'https://x.invalid/#'},{baseUrl:'https://secret:x@x.invalid/'},{token:'aw_host_'+'a'.repeat(43)},{consumerId:'bad/path'}]) {
    assert.throws(()=>createChatBridge({...options,...config}));
  }
  for (const input of [
    tool('chat_send',{roomId:'general',body:'Test'}),
    tool('chat_read',{roomId:'../../api/host/heartbeat'}),
    tool('chat_read',{roomId:'general',limit:1000}),
    tool('chat_read',{roomId:'general',consumer:'forged'}),
    tool('tasks_request_decision',{roomId:'general',question:'Choice?',options:['A','B']}),
  ]) assert.equal((await bridge.call(input)).isError,true);
  assert.equal(requests.length,0);
  assert.deepEqual(data(await bridge.call(tool('chat_read',{roomId:'general'}))),{messages:[message],nextCursor:'1',hasMore:false});
  assert.equal(requests[0][0].searchParams.get('consumer'),'one');
  assert.equal(requests[0][0].pathname,'/api/rooms/general/messages');
  assert.equal(data(await bridge.call(tool('chat_send',{roomId:'general',body:'literal @B',clientRequestId:'fixed'}))).message.body,'literal @B');
  assert.deepEqual(JSON.parse(requests[1][1].body),{clientRequestId:'fixed',body:'literal @B'});
  for(const [url,init] of requests){
    assert.equal(url.origin,origin);
    assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer '+agent);
  }
});

test('fail closed on forbidden or oversize responses, without echoing server error bodies',async()=>{
  const responses=[
    json({error:agent},401),
    new Response('x'.repeat(1_300_000)),
    new Response('',{status:302,headers:{Location:'https://else.invalid/'}}),
    new Response(null,{status:204}),
    json([]),
    json({messages:[],nextCursor:agent,hasMore:false}),
    json({messages:[{...message,roomId:'a-different-room',body:agent}],nextCursor:'1',hasMore:false}),
  ];
  const bridge=createChatBridge({...options,fetchImpl:async()=>responses.shift()});
  while(responses.length){
    const result=await bridge.call(tool('chat_read',{roomId:'general'}));
    assert.equal(result.isError,true);
    assert.ok(!JSON.stringify(result).includes(agent));
  }
});

test('child stdio handshake and allowlist are offline and keep stdout JSON-RPC only',{timeout:5000},async t=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../connector/mcp-chat.mjs',import.meta.url))],{
    env:{...process.env,WORKSPACE_MCP_ORIGIN:origin,WORKSPACE_MCP_AGENT_TOKEN:agent,WORKSPACE_MCP_CONSUMER_ID:'child'},
    stdio:['pipe','pipe','pipe'],
  });
  const exited=once(child,'exit');t.after(()=>child.kill());
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const send=(method,id,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,id,params})+'\n');
  const receive=async()=>JSON.parse((await lines.next()).value);
  send('tools/list',1);assert.equal((await receive()).error.code,-32002);
  send('initialize',2,{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1.0'}});
  const initialize=await receive();assert.equal(initialize.result.protocolVersion,'2025-06-18');assert.deepEqual(initialize.result.capabilities,{tools:{}});
  send('notifications/initialized');send('tools/list',3);
  const list=await receive();assert.deepEqual(list.result.tools.map(x=>x.name),['chat_read','chat_send','tasks_request_decision']);
  send('tools/call',4,tool('unknown',{}));assert.equal((await receive()).result.isError,true);
  child.stdin.write('x'.repeat(70_000)+'\n');assert.equal((await receive()).error.message,'Request frame exceeds the bridge limit');
  send('ping',5);assert.deepEqual((await receive()).result,{});
  send('resources/list',6);assert.equal((await receive()).error.code,-32601);
  send('tools/list',7,{cursor:'not-supported'});assert.equal((await receive()).error.code,-32602);
  child.stdin.end();assert.deepEqual(await exited,[0,null]);assert.equal(stderr,'');
});

test('actual SQLite/HTTP exercise: membership, explicit retrieval, idempotency, and no automatic peer wake',async t=>{
  const {createWorkspaceServer}=await import('../server/index.mjs');
  const {openWorkspace}=await import('../server/workspace.mjs');
  const store=openWorkspace(':memory:');
  const created=store.createAgent(store.owner,{name:'Ada'});
  const target=store.createAgent(store.owner,{name:'Lin'});
  const other=store.createRoom(store.owner,{name:'Private'});
  store.send(store.owner,'general',{clientRequestId:'one',body:'Owner message'});
  const server=createWorkspaceServer({store,ownerToken:'one-synthetic-owner-token-at-least-32'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const bridge=createChatBridge({...options,token:created.token,baseUrl:'http://127.0.0.1:'+server.address().port});
  assert.equal((await bridge.call(tool('chat_read',{roomId:other.id}))).isError,true);
  assert.deepEqual(data(await bridge.call(tool('chat_read',{roomId:'general'}))).messages.map(x=>x.body),['Owner message']);
  assert.deepEqual(data(await bridge.call(tool('chat_read',{roomId:'general'}))).messages,[]);
  const sibling=createChatBridge({...options,consumerId:'session-two',token:created.token,baseUrl:'http://127.0.0.1:'+server.address().port});
  assert.deepEqual(data(await sibling.call(tool('chat_read',{roomId:'general'}))).messages.map(x=>x.body),['Owner message']);
  const send=tool('chat_send',{roomId:'general',body:'Check this',clientRequestId:'same',mentions:[target.agent.id]});
  const first=data(await bridge.call(send)).message;
  assert.equal(data(await bridge.call(send)).message.id,first.id);
  assert.equal(first.authorId,created.agent.id);
  const changed=await bridge.call(tool('chat_send',{...send.arguments,body:'Different content'}));
  assert.equal(changed.isError,true);assert.match(changed.content[0].text,/409/);
  const reminders=store.listReminders(store.authenticateAgent(target.token));
  assert.equal(reminders.length,1);
  assert.equal(reminders[0].status,'blocked_no_execution_context');
});

test('child rejects a host token at startup without emitting RPC frames or secrets',{timeout:5000},async t=>{
  const wrongToken='aw_host_'+'z'.repeat(43);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../connector/mcp-chat.mjs',import.meta.url))],{
    env:{...process.env,WORKSPACE_MCP_ORIGIN:origin,WORKSPACE_MCP_AGENT_TOKEN:wrongToken,WORKSPACE_MCP_CONSUMER_ID:'wrong-scope'},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',v=>stdout+=v);
  child.stderr.setEncoding('utf8').on('data',v=>stderr+=v);
  const closed=once(child,'close');
  t.after(()=>child.kill());
  assert.deepEqual(await closed,[1,null]);
  assert.equal(stdout,'');
  assert.match(stderr,/dedicated Workspace Agent token/);
  assert.ok(!stderr.includes(wrongToken));
});

test('thread pages preserve authorized task and reply references without consuming unrelated messages',async t=>{
  const {createWorkspaceServer}=await import('../server/index.mjs');
  const {openWorkspace}=await import('../server/workspace.mjs');
  const store=openWorkspace(':memory:');
  const {agent:lee,token}=store.createAgent(store.owner,{name:'Lee'});
  const task=store.createTask(store.owner,{roomId:'general',title:'Check build notes',assigneeId:lee.id});
  const root=store.send(store.owner,'general',{clientRequestId:'thread-root',body:'Build notes',taskRef:task.id});
  store.send(store.owner,'general',{clientRequestId:'unrelated',body:'Unrelated planning'});
  const server=createWorkspaceServer({store,ownerToken:'another-synthetic-token-at-least-32-long'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const bridge=createChatBridge({...options,token,baseUrl:'http://127.0.0.1:'+server.address().port});
  let result=await bridge.call(tool('chat_send',{roomId:'general',clientRequestId:'notes',body:'Notes checked.',replyTo:root.id,taskRef:task.id}));
  assert.equal(result.isError,undefined);
  const reply=data(result).message;
  assert.equal(reply.replyTo,root.id);
  assert.equal(reply.taskRef,task.id);

  const args={roomId:'general',thread:root.id,limit:1};
  const first=data(await bridge.call(tool('chat_read',args)));
  assert.deepEqual(first.messages.map(message=>message.id),[root.id]);
  assert.equal(first.hasMore,true);
  const next=data(await bridge.call(tool('chat_read',{...args,after:first.nextCursor})));
  assert.deepEqual(next.messages.map(message=>message.id),[reply.id]);
  assert.equal(next.messages[0].taskRef,task.id);
  assert.equal(next.hasMore,false);
  assert.deepEqual(data(await bridge.call(tool('chat_read',{roomId:'general',limit:2}))).messages.map(message=>message.body),['Build notes','Unrelated planning']);

  store.setAgentEnabled(store.owner,lee.id,false);
  result=await bridge.call(tool('chat_read',args));
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/401/);
});

test('stdio recovers from mixed framing, incomplete EOF, and invalid initialization without acting',async()=>{
  const frame=(id,method,params)=>JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n';
  const seen=[];
  const output=new Writable({write(chunk,_encoding,done){seen.push(JSON.parse(chunk.toString()));done();}});
  async function* chunks(){
    yield 'not JSON\n'+JSON.stringify([1,2])+'\n';
    yield Buffer.from(frame('bad','initialize',{protocolVersion:42}));
    const next=frame('start','initialize',{protocolVersion:'future-client'});
    yield next.slice(0,21);
    yield next.slice(21)+frame(null,'ping')+frame('again','initialize',{protocolVersion:'2025-06-18'});
    yield frame(undefined,'notifications/initialized')+frame('list','tools/list',{}).trimEnd();
  }
  await serveStdio({call(){assert.fail('Malformed or incomplete frames must not invoke tools');}},{input:chunks(),output});
  assert.deepEqual(seen.map(x=>[x.id,x.error?.code??x.result.protocolVersion]),[
    [null,-32700],[null,-32600],['bad',-32602],['start','2025-11-25'],[null,-32600],['again',-32602],[null,-32700],
  ]);
});

test('malformed optional references are rejected before transport and disconnects give a generic tool error',async()=>{
  let calls=0;
  const bridge=createChatBridge({...options,fetchImpl:async()=>{
    calls++;
    throw new Error('simulated disconnected upstream '+agent);
  }});
  const messageArgs={roomId:'general',clientRequestId:'req',body:'Reply'};
  for(const params of [
    tool('chat_read',{roomId:'general',after:'not-a-cursor'}),
    tool('chat_read',{roomId:'general',thread:null}),
    tool('chat_send',{...messageArgs,replyTo:'bad path'}),
    tool('chat_send',{...messageArgs,taskRef:7}),
    null,
  ]) assert.equal((await bridge.call(params)).isError,true);
  assert.equal(calls,0);
  const failure=await bridge.call(tool('chat_read',{roomId:'general'}));
  assert.equal(calls,1);
  assert.equal(failure.isError,true);
  assert.match(failure.content[0].text,/transport failed/);
  assert.ok(!failure.content[0].text.includes(agent));
});

test('explicit MCP decision is scoped, idempotent, and never inferred from chat',async t=>{
  const {createWorkspaceServer}=await import('../server/index.mjs');
  const {openWorkspace}=await import('../server/workspace.mjs');
  const store=openWorkspace(':memory:');
  const {agent:requester,token}=store.createAgent(store.owner,{name:'Requester'});
  const {agent:peer,token:peerToken}=store.createAgent(store.owner,{name:'Peer'});
  const outside=store.createRoom(store.owner,{name:'Other room'});
  const outsideMessage=store.send(store.owner,outside.id,{clientRequestId:'outside',body:'private'});
  const source=store.send(store.owner,'general',{clientRequestId:'root',body:'Prepare summary'});
  const assigned=store.createTask(store.owner,{roomId:'general',assigneeId:requester.id,title:'Prepare'});
  const forbidden=store.createTask(store.owner,{roomId:'general',assigneeId:peer.id,title:'Other'});
  const ownerToken='synthetic-owner-token-at-least-32-chars';
  const server=createWorkspaceServer({store,ownerToken});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const baseUrl='http://127.0.0.1:'+server.address().port;
  const bridge=createChatBridge({...options,token,baseUrl});
  const ask={clientRequestId:'decision-1',roomId:'general',taskRef:assigned.id,
    messageRef:source.id,question:'Which format?',options:['Markdown','PDF']};
  const call=arg=>bridge.call(tool('tasks_request_decision',{...ask,...arg}));

  const sent=await bridge.call(tool('chat_send',{roomId:'general',clientRequestId:'plain',
    body:'Which format? @Peer'}));
  assert.equal(sent.isError,undefined);
  assert.equal(store.listDecisions(store.owner).length,0);
  assert.equal(store.listReminders(peer).length,0);

  for(const invalid of [{taskRef:forbidden.id},{messageRef:outsideMessage.id},{roomId:outside.id},
    {ownerId:peer.id},{authorId:'owner'},{options:['same',' same ']},{clientRequestId:null}]){
    assert.equal((await call(invalid)).isError,true);
  }
  const both=await Promise.all([call({}),call({})]);
  assert.equal(both[0].isError,undefined);
  assert.deepEqual(data(both[0]),data(both[1]));
  const d=data(both[0]).decision;
  assert.equal(d.status,'pending');
  assert.equal(d.authorId,requester.id);
  assert.equal(d.ownerId,store.owner.id);
  assert.equal(d.taskRef,assigned.id);
  assert.equal(d.messageRef,source.id);
  assert.match((await call({question:'Different'})).content[0].text,/409/);
  assert.equal(store.listDecisions(store.owner).length,1);
  assert.equal(store.listDecisions(peer).length,0);
  const api=async (path,bearer,payload)=>fetch(baseUrl+path,{method:'POST',
    headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const resolution='/api/decisions/'+d.id+'/resolve';
  assert.equal((await api(resolution,peerToken,{response:'PDF'})).status,403);
  const handled=await api(resolution,ownerToken,{response:'PDF'});
  assert.equal(handled.status,200);
  assert.equal((await handled.json()).decision.status,'resolved');
  assert.equal(data(await call({})).decision.response,'PDF');
  const ownerMade=await api('/api/decisions',ownerToken,{roomId:'general',question:'Still works?',options:['Yes','No']});
  assert.equal(ownerMade.status,201);
  assert.equal((await ownerMade.json()).decision.authorId,store.owner.id);
  assert.equal(store.listReminders(peer).length,0);
  assert.equal(store.listMessages(store.owner,'general',{}).messages.length,2);
  store.setRoomMember(store.owner,'general',requester.id,false);
  assert.match((await call({})).content[0].text,/404/);
  store.setAgentEnabled(store.owner,requester.id,false);
  assert.match((await call({})).content[0].text,/401/);
});

test('decision bridge rejects mismatched or malformed API responses without echoing extra data',async()=>{
  const ask={roomId:'general',clientRequestId:'new',question:'Choose',options:['A','B']};
  const d={id:'decision-1',roomId:'general',taskRef:null,messageRef:null,
    ownerId:'owner',authorId:'agent-1',question:ask.question,options:ask.options,status:'pending',
    response:null,createdAt:new Date(0).toISOString()};
  const responses=[{...d,taskRef:'foreign'},{...d,status:'resolved',response:'C'},
    {...d,roomId:'another'},{...d,createdAt:null},{...d,arbitrary:agent}];
  const bridge=createChatBridge({...options,fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).pathname,'/api/decisions');
    assert.equal(init.method,'POST');
    assert.equal(init.redirect,'error');
    assert.deepEqual(JSON.parse(init.body),ask);
    return json({decision:responses.shift(),arbitrary:agent},201);
  }});
  for(let i=0;i<4;i++) assert.equal((await bridge.call(tool('tasks_request_decision',ask))).isError,true);
  assert.deepEqual(data(await bridge.call(tool('tasks_request_decision',ask))),{decision:d});
});
