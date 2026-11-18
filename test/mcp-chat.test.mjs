import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChatBridge } from '../connector/mcp-chat.mjs';

const origin='http://127.0.0.1:4319';
const agent='aw_agent_'+'a'.repeat(43);
const options={baseUrl:origin,token:agent,consumerId:'one'};
const tool=(name,args)=>({name,arguments:args});
const data=result=>JSON.parse(result.content[0].text);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const message={id:'m1',roomId:'general',authorId:'agent-1',authorName:'A',authorKind:'agent',body:'Hello',mentions:[],replyTo:null,taskRef:null,createdAt:new Date(0).toISOString()};

test('bridge allows only typed chat endpoints, never forwards secrets or redirects, and requires a stable mutation ID',async()=>{
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
  const responses=[json({error:agent},401),new Response('x'.repeat(1_300_000)),new Response('',{status:302,headers:{Location:'https://else.invalid/'}})];
  const bridge=createChatBridge({...options,fetchImpl:async()=>responses.shift()});
  for(let i=0;i<3;i++){
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
  const list=await receive();assert.deepEqual(list.result.tools.map(x=>x.name),['chat_read','chat_send']);
  send('tools/call',4,tool('unknown',{}));assert.equal((await receive()).result.isError,true);
  child.stdin.write('x'.repeat(70_000)+'\n');assert.equal((await receive()).error.message,'Request frame exceeds the bridge limit');
  send('ping',5);assert.deepEqual((await receive()).result,{});
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
