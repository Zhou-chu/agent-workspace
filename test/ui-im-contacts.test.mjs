import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';

test('human contacts UI persists reciprocal friendship, private chat, and foreground read over HTTP', {timeout:12_000}, async t=>{
  const ownerToken=randomBytes(32).toString('hex');
  const store=openWorkspace(':memory:','Alice');
  const {human:bob,token:bobToken}=store.provisionHuman(store.owner,{name:'Bob'});
  const signals=[];
  const server=createWorkspaceServer({store,ownerToken,imObjects:{
    async put(){},async get(){return null;},async delete(){},
  },createRealtime:()=>({
    notifyContacts:(...ids)=>signals.push(['contacts.changed',...ids]),
    notifyRoom:(...ids)=>signals.push(['room.changed',...ids]),
    notifyRoomRead:(...ids)=>signals.push(['read.changed',...ids]),close(){},
  })});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const exchange=globalThis.fetch;
  const dom=new JSDOM(await (await exchange(origin)).text(),{url:origin,pretendToBeVisual:true});
  const doc=dom.window.document;
  t.after(async()=>{
    dom.window.close();
    server.stopImRealtime();
    await new Promise(resolve=>server.close(resolve));
    store.close();
  });
  function substitute(name,value) {
    const before=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
    t.after(()=>before?Object.defineProperty(globalThis,name,before):delete globalThis[name]);
  }
  let cookie, focused=false;
  const sockets=[];
  const observedReads=[];
  class TestSocket extends EventTarget {
    constructor(){super();sockets.push(this);}
    close(){this.dispatchEvent(new Event('close'));}
    message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  }
  Object.defineProperty(doc,'hasFocus',{value:()=>focused});
  substitute('document',doc);
  substitute('localStorage',dom.window.localStorage);
  substitute('setInterval',()=>0);
  substitute('WebSocket',TestSocket);
  const request=(path,{cookie,method='GET',data}={})=>exchange(origin+path,{
    method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
    body:data?JSON.stringify(data):undefined,
  });
  substitute('fetch',async (path,options)=>{
    if(path.endsWith('/read')) observedReads.push(JSON.parse(options.body).cursor);
    const response=await exchange(origin+path,{
      ...options,headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})},
    });
    const next=response.headers.get('set-cookie');
    if(next) cookie=next.split(';')[0];
    return response;
  });

  const buttonNamed=text=>[...doc.querySelectorAll('button')].find(node=>
    node.getAttribute('aria-label')===text||node.textContent.trim()===text);
  const event=(node,name)=>node.dispatchEvent(new dom.window.Event(name,{bubbles:true,cancelable:true}));
  async function until(predicate,description) {
    const end=Date.now()+3000;
    do {
      const result=predicate();
      if(result) return result;
      await delay(10);
    } while(Date.now()<end);
    assert.fail('UI did not reach: '+description);
  }
  async function click(text) {
    const control=await until(()=>buttonNamed(text),text);
    control.click();
    return control;
  }
  async function login(key) {
    const input=await until(()=>doc.querySelector('#login-token'),'login');
    input.value=key;
    event(input.form,'submit');
    await until(()=>buttonNamed('联系人'),'contacts control after login');
  }
  function activeRoom() {return doc.querySelector('.room[aria-current=true]');}
  const historyBodies=()=>[...doc.querySelectorAll('.feed [data-message] p.body')].map(item=>item.textContent);
  const readCounts=async session=>{
    const {rooms}=await (await request('/api/rooms',{cookie:session})).json();
    return rooms.filter(room=>room.kind==='direct');
  };
  const verifyContacts=async (session,expected)=>{
    const response=await request('/api/contacts',{cookie:session});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),expected);
  };

  await import('../frontend/public/app.mjs');
  await login(ownerToken);
  const contacts=await click('联系人');
  assert.equal(contacts.getAttribute('aria-expanded'),'true');
  const query=await until(()=>doc.querySelector('input[type=search]'),'search field');
  query.value='Bob';
  event(query.form,'submit');
  await click('发起好友申请');
  await until(()=>doc.body.textContent.includes('已发出好友申请。'),'outgoing receipt');
  await until(()=>doc.body.textContent.includes('等待确认'),'outgoing request displayed');
  assert.equal(buttonNamed('发消息'),undefined);
  await verifyContacts(cookie,{friends:[],incoming:[],outgoing:[{id:bob.id,name:'Bob'}]});
  assert.deepEqual(await readCounts(cookie),[]);

  await click('设置');
  await click('退出登录');
  await login(bobToken);
  await click('联系人');
  await click('接受好友申请');
  await until(()=>doc.body.textContent.includes('已接受好友申请。'),'accept receipt');
  await verifyContacts(cookie,{friends:[{id:'owner',name:'Alice'}],incoming:[],outgoing:[]});
  await click('发消息');
  const room=await until(()=>activeRoom()?.getAttribute('aria-label')==='Alice'&&activeRoom(),'Alice private conversation');
  assert.equal(contacts.isConnected,false);
  assert.ok(doc.querySelector('[aria-label="私聊消息"]'));
  assert.equal(buttonNamed('@ 选择成员'),undefined);
  const roomId=room.dataset.room;

  const external=await request('/api/login',{method:'POST',data:{token:ownerToken}});
  assert.equal(external.status,200);
  await external.body.cancel();
  const aliceCookie=external.headers.get('set-cookie').split(';')[0];
  const before=await readCounts(aliceCookie);
  assert.equal(before.length,1);
  assert.equal(before[0].id,roomId);
  for(let n=1;n<=3;n++) {
    const message=await request('/api/rooms/'+roomId+'/messages',{cookie:aliceCookie,method:'POST',data:{
      body:'offline '+n,clientRequestId:'contact-test-'+n,mentions:[],
    }});
    assert.equal(message.status,201);
    await message.body.cancel();
  }
  const socket=await until(()=>sockets[1],'Bob socket');
  socket.message({type:'room.changed',roomId});
  await until(()=>historyBodies().length===3,'ordered background messages');
  await until(()=>activeRoom()?.getAttribute('aria-describedby'),'unread room has accessible description');
  const badge=activeRoom().querySelector('[data-unread]');
  assert.equal(badge.dataset.unread,'3');
  assert.equal(doc.getElementById(activeRoom().getAttribute('aria-describedby')).textContent,'3 条未读消息');
  assert.deepEqual(historyBodies(),['offline 1','offline 2','offline 3']);
  assert.deepEqual(observedReads,[]);
  assert.equal((await readCounts(cookie))[0].unread,3);

  focused=true;
  event(dom.window,'focus');
  await until(()=>!activeRoom()?.getAttribute('aria-describedby'),'foreground acknowledges loaded messages');
  assert.equal((await readCounts(cookie))[0].unread,0);
  assert.equal(observedReads.length,1);
  const persisted=await (await request('/api/rooms/'+roomId+'/messages',{cookie})).json();
  assert.equal(observedReads[0],persisted.nextCursor);
  assert.equal(signals.some(frame=>frame[0]==='read.changed'&&frame[1]===bob.id&&frame[2]===roomId),true);
});
