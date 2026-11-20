import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';

test('modern IM UI handles invitations, lost upload replies, and realtime retractions', {timeout:9000}, async t=>{
  const ownerToken=randomBytes(32).toString('hex');
  const store=openWorkspace(':memory:','Alice');
  const objects=new Map();
  const invalidations=[];
  const server=createWorkspaceServer({store,ownerToken,
    imObjects:{
      async put(id,bytes){objects.set(id,bytes);},
      async get(id){return objects.get(id)??null;},
      async delete(id){objects.delete(id);},
    },
    createRealtime:()=>({notifyRoom:roomId=>invalidations.push(roomId),close(){}}),
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const nativeFetch=globalThis.fetch;
  const dom=new JSDOM(await (await nativeFetch(origin)).text(),{url:origin,pretendToBeVisual:true});
  t.after(async()=>{
    dom.window.close();
    server.stopImRealtime();
    await new Promise(resolve=>server.close(resolve));
    store.close();
  });

  // A controllable browser event source; real WebSocket delivery/decoding is
  // tested separately. All application API requests below use HTTP and SQLite.
  const sockets=[];
  class TestSocket extends EventTarget {
    constructor(url){super();this.url=url;sockets.push(this);}
    emit(value){this.dispatchEvent(new MessageEvent('message',{data:value}));}
    close(){this.dispatchEvent(new Event('close'));}
  }
  function substitute(name,value) {
    const original=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
    t.after(()=>original?Object.defineProperty(globalThis,name,original):delete globalThis[name]);
  }
  substitute('document',dom.window.document);
  substitute('localStorage',dom.window.localStorage);
  substitute('setInterval',()=>0);
  substitute('WebSocket',TestSocket);
  substitute('navigator',{mediaDevices:{getUserMedia:async()=>{throw new Error('Microphone denied by fixture');}}});
  substitute('MediaRecorder',{isTypeSupported:()=>true});
  let cookie, dropUploadReceipt=true;
  const uploads=[];
  let historyCalls=0;
  substitute('fetch', async (path,options)=>{
    const headers={...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})};
    if(path.startsWith('/api/rooms/general/messages?')) historyCalls++;
    const response=await nativeFetch(origin+path,{...options,headers});
    const nextCookie=response.headers.get('set-cookie');
    if(nextCookie) cookie=nextCookie.split(';')[0];
    if(path.endsWith('/attachments')) {
      assert.equal(response.status,201);
      uploads.push(headers['X-AgentChat-Request-Id']);
      if(dropUploadReceipt) {
        dropUploadReceipt=false;
        await response.body.cancel();
        return new Response(JSON.stringify({error:'fixture reply lost'}),{status:503});
      }
    }
    return response;
  });

  const doc=dom.window.document;
  const text=()=>doc.body.textContent;
  const named=(selector,label)=>[...doc.querySelectorAll(selector)].find(node=>node.textContent.trim()===label);
  async function waitFor(predicate,label) {
    const end=Date.now()+3000;
    do {
      const value=predicate();
      if(value) return value;
      await delay(10);
    } while(Date.now()<end);
    assert.fail('DOM condition not reached: '+label);
  }
  async function click(label){(await waitFor(()=>named('button',label),label)).click();}
  function event(node,name){node.dispatchEvent(new dom.window.Event(name,{bubbles:true,cancelable:true}));}
  await import('../frontend/public/app.mjs');
  const login=await waitFor(()=>doc.querySelector('#login-token'),'login');
  login.value=ownerToken;
  event(login.form,'submit');
  await waitFor(()=>named('h1','General'),'general room');
  await waitFor(()=>historyCalls>0,'initial history');
  const initialSocket=sockets[0];
  assert.equal(String(initialSocket.url),'ws://'+new URL(origin).host+'/ws');
  const beforeOpen=historyCalls;
  initialSocket.dispatchEvent(new Event('open'));
  await waitFor(()=>historyCalls>beforeOpen,'resync on open');
  const afterOpen=historyCalls;
  initialSocket.emit('unrecognized frame');
  initialSocket.emit(JSON.stringify({type:'room.changed',roomId:'different'}));
  assert.equal(historyCalls,afterOpen);
  initialSocket.emit(JSON.stringify({type:'room.changed',roomId:'general'}));
  await waitFor(()=>historyCalls>afterOpen,'resync on matching invalidation');
  initialSocket.close();
  const replacement=await waitFor(()=>sockets[1],'socket replaced after closure');
  replacement.dispatchEvent(new Event('open'));

  await click('设置');
  await click('添加真人成员');
  const name=[...doc.querySelectorAll('label')].find(label=>label.textContent==='真人显示名称').querySelector('input');
  event(name.form,'submit');
  await waitFor(()=>text().includes('Invalid name'),'empty invitation denied');
  name.value='Bob';
  event(name.form,'submit');
  await waitFor(()=>doc.querySelector('[data-testid=human-invitation]'),'invitation shown');
  await click('隐藏成员密钥');
  assert.equal(doc.querySelector('[data-testid=human-invitation]'),null);
  await click('群聊');
  const picker=await waitFor(()=>doc.querySelector('[aria-label="发送文件"]'),'media picker');
  Object.defineProperty(picker,'files',{value:[new File(['local test bytes'],'proof.txt',{type:'text/plain'})]});
  event(picker,'change');
  await waitFor(()=>text().includes('未确认附件发送'),'lost receipt indicated');
  await click('重试附件');
  const link=await waitFor(()=>named('a','下载 proof.txt'),'persisted upload');
  assert.equal(uploads.length,2);
  assert.equal(uploads[0],uploads[1]);
  assert.equal(objects.size,1);
  assert.equal([...doc.querySelectorAll('[download]')].length,1);
  assert.equal(await (await nativeFetch(link.href,{headers:{Cookie:cookie}})).text(),'local test bytes');
  await click('撤回');
  await waitFor(()=>text().includes('消息已撤回'),'retracted message');
  assert.equal(doc.querySelector('[download]'),null);
  assert.equal(objects.size,0);
  assert.deepEqual(invalidations,['general','general','general']);
  await click('录制语音');
  await waitFor(()=>text().includes('无法录音，请检查浏览器麦克风权限。'),'microphone permission feedback');
  await click('设置');
  await click('退出登录');
  await waitFor(()=>doc.querySelector('#login-token'),'logout returns to login');
});
