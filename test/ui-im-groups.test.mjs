import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';

test('managed group UI exercises real admission, roles, announcements and membership changes', {timeout:16_000}, async t=>{
  const token=randomBytes(32).toString('hex');
  const store=openWorkspace(':memory:','Alice');
  const {human:bob,token:bobKey}=store.provisionHuman(store.owner,{name:'Bob'});
  const {human:carol,token:carolKey}=store.provisionHuman(store.owner,{name:'Carol'});
  store.contacts.request(store.owner,bob.id);
  store.contacts.accept(bob,store.owner.id);
  store.contacts.request(bob,carol.id);
  store.contacts.accept(carol,bob.id);
  const notifications=[];
  const server=createWorkspaceServer({store,ownerToken:token,imObjects:{
    async put(){},async get(){return null;},async delete(){},
  },createRealtime:()=>({
    notifyRoom(){},notifyGroupInvites:(...args)=>notifications.push(['group-invites.changed',...args]),
    notifyGroupMembership:(...args)=>notifications.push(['group-membership.changed',...args]),close(){},
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
  function install(name,value) {
    const before=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
    t.after(()=>before?Object.defineProperty(globalThis,name,before):delete globalThis[name]);
  }
  const sockets=[];
  class FixtureSocket extends EventTarget {
    constructor(){super();sockets.push(this);}
    close(){this.dispatchEvent(new Event('close'));}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
  }
  let cookie, holdReviewRefresh=false;
  const reviewRefresh=Promise.withResolvers();
  t.after(reviewRefresh.resolve);
  install('document',doc);
  install('localStorage',dom.window.localStorage);
  install('WebSocket',FixtureSocket);
  install('setInterval',()=>0);
  install('fetch',async (path,options)=>{
    if(holdReviewRefresh&&path==='/api/im/groups/'+roomId&&options.method==='GET') await reviewRefresh.promise;
    const response=await exchange(origin+path,{
      ...options,headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})},
    });
    if(options.method==='PATCH'&&path.includes('/invites/')&&JSON.parse(options.body).action==='approve') holdReviewRefresh=true;
    const next=response.headers.get('set-cookie');
    if(next) cookie=next.split(';')[0];
    return response;
  });
  function control(name,container=doc) {
    return [...container.querySelectorAll('button')].find(node=>!node.closest('[hidden]')&&
      (node.getAttribute('aria-label')===name||node.textContent.trim()===name));
  }
  function input(name,selector='input') {
    return [...doc.querySelectorAll('label')].find(node=>!node.closest('[hidden]')&&
      Array.from(node.childNodes).filter(item=>item.nodeType===3||item.tagName==='SPAN').map(item=>item.textContent).join('').trim()===name)
      ?.querySelector(selector);
  }
  function submit(node){node.form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));}
  function row(name) {
    return [...doc.querySelectorAll('[aria-label="群成员"] li')].find(node=>node.querySelector('strong')?.textContent===name);
  }
  function role(name){return row(name)?.querySelector('.badge')?.textContent;}
  async function until(condition,name) {
    const deadline=Date.now()+3000;
    do {const value=condition();if(value) return value;await delay(10);} while(Date.now()<deadline);
    assert.fail('UI did not reach: '+name);
  }
  async function click(name,container=doc) {
    const node=await until(()=>control(name,container),name);
    node.click();
    return node;
  }
  async function login(key) {
    const field=await until(()=>doc.querySelector('#login-token'),'login screen');
    field.value=key;
    submit(field);
    await until(()=>control('群聊邀请'),'managed group capability');
  }
  async function logout(){await click('设置');await click('退出登录');}
  async function accept() {
    await click('群聊邀请');
    const acceptButton=await until(()=>control('接受群聊邀请'),'incoming invitation');
    assert.match(acceptButton.closest('li').textContent,/加入后可以查看群聊历史消息与公告/);
    acceptButton.click();
    await until(()=>doc.querySelector('.conversation h1')?.textContent==='技术组','managed conversation');
  }
  async function openMembers(){
    await click('成员');
    await until(()=>doc.querySelector('[aria-label="群成员"] li'),'member rows');
  }
  const detail=actor=>store.groups.detail(actor,roomId);
  const invites=actor=>store.groups.personalInvites(actor);
  let roomId;

  await import('../frontend/public/app.mjs');
  await login(token);
  await click('新建群聊');
  const groupName=await until(()=>input('群聊名称'),'group name');
  groupName.value='技术组';
  const pickBob=await until(()=>input('Bob'),'Bob selection');
  pickBob.checked=true;
  submit(groupName);
  await until(()=>doc.querySelector('.conversation h1')?.textContent==='技术组','new conversation');
  roomId=doc.querySelector('.room[aria-current=true]').dataset.room;
  assert.equal(invites(bob)[0].status,'pending_acceptance');
  await openMembers();
  assert.equal(role('Alice'),'群主');
  assert.equal(control('退出群聊'),undefined);
  const originalAnnouncement=await until(()=>input('公告内容','textarea'),'announcement editor');
  originalAnnouncement.value='先阅读接口约定。';
  submit(originalAnnouncement);
  await until(()=>doc.querySelector('.group-announcement p')?.textContent==='先阅读接口约定。','published announcement');

  await logout();
  await login(bobKey);
  assert.equal(control('技术组'),undefined);
  await accept();
  await openMembers();
  assert.equal(role('Bob'),'成员');
  assert.equal(control('发布公告'),undefined);
  assert.equal(control('批准邀请'),undefined);
  await until(()=>doc.querySelector('.group-announcement p')?.textContent==='先阅读接口约定。','pre-join announcement after acceptance');
  await click('邀请好友');
  const select=await until(()=>input('选择好友','select'),'friend choices');
  assert.equal(select.getAttribute('aria-label'),'选择好友','friend picker name must not include option text');
  select.value=carol.id;
  submit(select);
  await until(()=>doc.body.textContent.includes('已发出邀请。'),'invitation submitted');
  assert.equal(invites(bob).find(invite=>invite.userId===carol.id).status,'pending_review');
  assert.deepEqual(invites(carol),[]);

  await logout();
  await login(token);
  await click('技术组');
  await openMembers();
  await click('批准邀请');
  await until(()=>doc.body.textContent.includes('已处理群聊邀请。'),'invitation approved');
  assert.equal(invites(carol)[0].status,'pending_acceptance');
  try {
    await click('设为管理员',row('Bob'));
    await until(()=>detail(store.owner).members.some(person=>person.id===bob.id&&person.role==='admin'),
      'promote action sends even while a successful review refresh is delayed');
  } finally {
    holdReviewRefresh=false;
    reviewRefresh.resolve();
  }
  await until(()=>role('Bob')==='管理员','promoted admin');

  await logout();
  await login(carolKey);
  await accept();
  await openMembers();
  assert.equal(role('Carol'),'成员');
  assert.equal(role('Bob'),'管理员');
  assert.equal(control('移出群聊',row('Bob')),undefined);
  await click('退出群聊');
  await click('取消');
  assert.equal(control('确认退出'),undefined);
  await click('退出群聊');
  await click('确认退出');
  await until(()=>!control('技术组')&&doc.querySelector('.conversation h1')?.textContent==='General','leaving removes rendered room');
  assert.equal(notifications.some(event=>event[0]==='group-membership.changed'&&event[1]===carol.id&&event[2]===roomId),true);

  await logout();
  await login(token);
  await click('技术组');
  await openMembers();
  await click('转让群主',row('Bob'));
  await click('确认转让');
  await until(()=>role('Alice')==='成员'&&role('Bob')==='群主','transferred authority');
  assert.equal(control('发布公告'),undefined);
  assert.equal(control('设为管理员'),undefined);
  assert.equal(detail(bob).role,'owner');
  assert.equal(detail(store.owner).role,'member');
  assert.ok(notifications.some(event=>event[0]==='group-invites.changed'&&event[3]===carol.id));

  const composer=doc.querySelector('[aria-label="消息正文"]');
  composer.value='离群后不应保留的草稿';
  composer.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  await click('设置');
  const switchActor=await exchange(origin+'/api/login',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:bobKey}),
  });
  assert.equal(switchActor.status,200);
  const managerCookie=switchActor.headers.get('set-cookie').split(';')[0];
  await switchActor.body.cancel();
  async function asBob(path,method,payload) {
    const response=await exchange(origin+path,{
      method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:managerCookie},body:JSON.stringify(payload),
    });
    assert.ok(response.ok,method+' '+path+' status '+response.status);
    await response.body.cancel();
  }
  await asBob('/api/im/groups/'+roomId+'/members/owner','PATCH',{action:'remove'});
  const revoke=notifications.at(-1);
  assert.deepEqual(revoke,['group-membership.changed','owner',roomId]);
  sockets.at(-1).message({type:revoke[0],roomId});
  assert.notEqual(dom.window.localStorage.getItem('workspace.room'),roomId);
  await asBob('/api/im/groups/'+roomId+'/invites','POST',{userId:'owner'});
  await click('群聊');
  await accept();
  assert.equal(doc.querySelector('[aria-label="消息正文"]').value,'');
});
