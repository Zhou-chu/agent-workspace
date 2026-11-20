import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));

async function reserve() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function writeSyntheticVoice(path) {
  const sampleRate=16_000, samples=16_000, bodySize=samples*2;
  const wav=Buffer.alloc(44+bodySize);
  wav.write('RIFF',0);
  wav.writeUInt32LE(36+bodySize,4);
  wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(sampleRate,24);
  wav.writeUInt32LE(sampleRate*2,28);
  wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34);
  wav.write('data',36);
  wav.writeUInt32LE(bodySize,40);
  for(let i=0;i<samples;i++) wav.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*240*i/sampleRate)),44+i*2);
  await writeFile(path,wav);
}

async function launch() {
  const ownerKey = randomBytes(32).toString('hex');
  const data = await mkdtemp(join(tmpdir(), 'agentchat-im-'));
  let backendPort, frontendPort;
  [backendPort,frontendPort] = await Promise.all([reserve(),reserve()]);
  const backend = 'http://127.0.0.1:' + backendPort;
  const origin = 'http://127.0.0.1:' + frontendPort;
  function start(script, config) {
    const child = spawn(process.execPath, [script], {cwd:root, env:{...process.env,...config},stdio:['ignore','pipe','pipe']});
    child.stdout.resume();
    child.stderr.resume();
    return {child, closed:once(child,'close')};
  }
  const processes = [
    start('server/api.mjs', {WORKSPACE_DATA_DIR:data, WORKSPACE_TOKEN:ownerKey, WORKSPACE_OWNER_NAME:'Alice', WORKSPACE_PORT:String(backendPort), WORKSPACE_PUBLIC_ORIGIN:origin}),
    start('frontend/gateway/index.mjs', {AGENTCHAT_FRONTEND_HOST:'127.0.0.1', AGENTCHAT_FRONTEND_PORT:String(frontendPort), AGENTCHAT_BACKEND_ORIGIN:backend}),
  ];
  async function stop() {
    for(const {child} of processes) child.kill();
    await Promise.all(processes.map(p=>p.closed));
    await rm(data,{recursive:true,force:true});
  }
  try {
    await expect.poll(async () => Promise.all([backend,origin].map(url=>fetch(url+'/healthz').then(r=>r.status,()=>0)))).toEqual([200,200]);
    expect((await fetch(backend+'/')).status).toBe(404);
    expect((await fetch(origin+'/')).status).toBe(200);
    const voiceSource=join(data,'synthetic-voice.wav');
    await writeSyntheticVoice(voiceSource);
    return {origin,ownerKey,voiceSource,stop};
  } catch (error) {
    await stop();
    throw error;
  }
}

async function login(page, origin, key) {
  await page.goto(origin);
  await page.getByLabel('访问密钥').fill(key);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'General',exact:true})).toBeVisible();
}

async function send(page, body) {
  await page.getByLabel('消息正文').fill(body);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.locator('.message .body').getByText(body,{exact:true})).toBeVisible();
}

test('two human accounts exchange, retract, transfer media and reconnect over live WebSocket', async () => {
  const {origin,ownerKey,voiceSource,stop} = await launch();
  let browser;
  try {
    browser=await chromium.launch({
      executablePath:process.env.AGENTCHAT_CHROMIUM||undefined,
      args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
        '--use-file-for-fake-audio-capture='+voiceSource],
    });
    const aliceContext = await browser.newContext({permissions:['microphone']});
    const bobContext = await browser.newContext();
    await aliceContext.addInitScript(()=>{
      const NativeRecorder=globalThis.MediaRecorder;
      let recorder, nonemptyChunks=0;
      globalThis.MediaRecorder=class extends NativeRecorder {
        constructor(...args) {
          super(...args);
          recorder=this;
          nonemptyChunks=0;
          this.addEventListener('dataavailable',event=>{ if(event.data.size>0) nonemptyChunks++; });
        }
      };
      globalThis.pollEncodedVoiceForTest=()=>{
        if(recorder?.state==='recording'&&nonemptyChunks<2) recorder.requestData();
        return nonemptyChunks;
      };
    });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await login(alice,origin,ownerKey);
    await alice.getByRole('button',{name:'设置',exact:true}).click();
    await alice.getByRole('button',{name:'添加真人成员',exact:true}).click();
    await alice.getByLabel('真人显示名称').fill('Bob');
    await alice.getByRole('button',{name:'生成成员密钥',exact:true}).click();
    const bobKey = await alice.getByTestId('human-invitation').textContent();
    expect(bobKey).toBeTruthy();
    await alice.getByRole('button',{name:'隐藏成员密钥',exact:true}).click();
    await alice.getByRole('button',{name:'群聊',exact:true}).click();

    const wsReady = bob.waitForEvent('websocket',{predicate:socket=>new URL(socket.url()).pathname==='/ws'});
    await login(bob,origin,bobKey);
    const socket = await wsReady;
    const who = await bob.request.get(origin+'/api/session');
    expect((await who.json()).user).toMatchObject({name:'Bob',kind:'human'});
    expect((await aliceContext.request.get(origin+'/api/session').then(r=>r.json())).user.name).toBe('Alice');

    const frame = socket.waitForEvent('framereceived',{predicate:({payload})=>typeof payload==='string'&&JSON.parse(payload).type==='room.changed'});
    await send(alice,'第一条实时消息');
    expect(JSON.parse((await frame).payload)).toEqual({type:'room.changed',roomId:'general'});
    const aliceMessage = bob.locator('.message').filter({has:bob.getByText('第一条实时消息',{exact:true})});
    await expect(aliceMessage.getByText('Alice',{exact:true})).toBeVisible();
    await expect(aliceMessage.getByRole('button',{name:'撤回',exact:true})).toHaveCount(0);
    await send(bob,'Bob 回复了');
    await expect(alice.locator('.message').filter({hasText:'Bob 回复了'}).getByText('Bob',{exact:true})).toBeVisible();

    await alice.locator('.message').filter({hasText:'第一条实时消息'}).getByRole('button',{name:'撤回',exact:true}).click();
    await expect(aliceMessage).toHaveCount(0);
    await expect(bob.getByText('消息已撤回',{exact:true})).toBeVisible();
    await bob.reload();
    await expect(bob.getByText('消息已撤回',{exact:true})).toBeVisible();
    await expect(bob.getByText('第一条实时消息',{exact:true})).toHaveCount(0);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSNsAAAAASUVORK5CYII=','base64');
    await alice.getByLabel('发送图片').setInputFiles({name:'proof.png',mimeType:'image/png',buffer:png});
    const image = bob.getByRole('img',{name:'proof.png'});
    await expect(image).toBeVisible();
    await expect.poll(()=>image.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
    const payload = Buffer.from('agentchat independent IM fixture\n');
    await alice.getByLabel('发送文件').setInputFiles({name:'proof.txt',mimeType:'text/plain',buffer:payload});
    const saved = bob.waitForEvent('download');
    await bob.getByRole('link',{name:'下载 proof.txt'}).click();
    const download = await saved;
    expect(download.suggestedFilename()).toBe('proof.txt');
    expect(await readFile(await download.path())).toEqual(payload);

    await alice.getByRole('button',{name:'录制语音',exact:true}).click();
    await expect(alice.getByText('正在录音',{exact:true})).toBeVisible();
    // A visible recording label can precede the first encoded sample. Two
    // nonempty chunks from the native recorder mean more than a container header.
    await expect.poll(()=>alice.evaluate(()=>globalThis.pollEncodedVoiceForTest())).toBeGreaterThanOrEqual(2);
    await alice.getByRole('button',{name:'停止并发送语音',exact:true}).click();
    const voice = bob.locator('audio[aria-label="语音消息"]');
    await expect(voice).toBeVisible();
    await expect.poll(()=>voice.evaluate(el=>el.readyState)).toBeGreaterThan(0);
    expect(await voice.evaluate(async el=>{await el.play();return !el.paused;})).toBe(true);
    await expect.poll(()=>voice.evaluate(el=>el.currentTime)).toBeGreaterThan(0);

    // Force the running browser connection to close; reconnect to the real
    // server throughout. Only the one offline interval is controlled here.
    let routeSocket, reconnectAllowed = true;
    await bobContext.routeWebSocket(/\/ws$/, ws=>{
      if(!reconnectAllowed) { void ws.close(); return; }
      ws.connectToServer();
      routeSocket=ws;
    });
    await bob.reload();
    await expect.poll(()=>Boolean(routeSocket)).toBe(true);
    reconnectAllowed=false;
    await routeSocket.close();
    await send(alice,'断线期间的消息');
    await expect(bob.getByText('断线期间的消息',{exact:true})).toHaveCount(0);
    reconnectAllowed=true;
    await expect(bob.getByText('断线期间的消息',{exact:true})).toBeVisible();
  } finally {
    try { await browser?.close(); } finally { await stop(); }
  }
});

test('humans confirm friendship, exchange private messages and catch up across unread pages', async () => {
  const {origin,ownerKey,stop} = await launch();
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.AGENTCHAT_CHROMIUM||undefined});
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    let socket, allowReconnect = true;
    await bobContext.routeWebSocket(/\/ws$/, route => {
      if (!allowReconnect) { void route.close(); return; }
      route.connectToServer();
      socket = route;
    });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await login(alice,origin,ownerKey);
    await alice.getByRole('button',{name:'设置',exact:true}).click();
    await alice.getByRole('button',{name:'添加真人成员',exact:true}).click();
    await alice.getByLabel('真人显示名称').fill('Bob');
    await alice.getByRole('button',{name:'生成成员密钥',exact:true}).click();
    const memberKey = await alice.getByTestId('human-invitation').textContent();
    expect(memberKey).toBeTruthy();
    await alice.getByRole('button',{name:'隐藏成员密钥',exact:true}).click();
    await alice.getByRole('button',{name:'群聊',exact:true}).click();
    await login(bob,origin,memberKey);
    await expect.poll(()=>Boolean(socket)).toBe(true);

    await alice.getByRole('button',{name:'联系人',exact:true}).click();
    await alice.getByRole('searchbox',{name:'搜索用户',exact:true}).fill('Bob');
    await alice.getByRole('button',{name:'搜索',exact:true}).click();
    await alice.getByRole('listitem').filter({hasText:'Bob'}).getByRole('button',{name:'发起好友申请',exact:true}).click();
    await expect(alice.getByRole('heading',{name:'发出的申请'})).toBeVisible();
    await expect(alice.getByRole('button',{name:'发消息',exact:true})).toHaveCount(0);

    await bob.getByRole('button',{name:'联系人',exact:true}).click();
    await bob.getByRole('listitem').filter({hasText:'Alice'}).getByRole('button',{name:'接受好友申请',exact:true}).click();
    await expect.poll(async () => (await alice.request.get(origin+'/api/contacts')).json()).toMatchObject({
      friends:[{name:'Bob'}],incoming:[],outgoing:[],
    });

    await bob.getByRole('listitem').filter({hasText:'Alice'}).getByRole('button',{name:'发消息',exact:true}).click();
    await expect(bob.getByRole('heading',{name:'Alice',exact:true})).toBeVisible();
    const visibleRooms = async page => (await page.request.get(origin+'/api/rooms')).json().then(data=>data.rooms);
    const bobRooms = await visibleRooms(bob);
    const direct = bobRooms.find(room => room.kind === 'direct');
    expect(direct?.peer.name).toBe('Alice');
    await expect.poll(async () => (await visibleRooms(alice)).find(room => room.kind==='direct')?.id).toBe(direct.id);
    await alice.getByRole('button',{name:'Bob',exact:true}).click();
    await send(alice,'私聊起点');
    await bob.bringToFront();
    await expect(bob.locator('.message .body').getByText('私聊起点',{exact:true})).toBeVisible();

    await expect.poll(async () => (await visibleRooms(bob)).find(room=>room.id===direct.id)?.unread).toBe(0);
    // Bob is viewing General and must not clear unread for an unrelated DM.
    await bob.getByRole('button',{name:'General',exact:true}).click();
    await expect(bob.getByRole('heading',{name:'General',exact:true})).toBeVisible();
    allowReconnect = false;
    await socket.close();
    await alice.locator('.message').filter({hasText:'私聊起点'})
      .getByRole('button',{name:'撤回',exact:true}).click();
    await send(alice,'离线队列首条');
    // Use the same authorized HTTP endpoint for repeatable fixtures spanning two pages.
    for (let index=1; index<=122; index++) {
      const response = await alice.request.post(origin+'/api/rooms/'+direct.id+'/messages',{
        data:{body:'离线批次 '+index,clientRequestId:'offline-fixture-'+index},
      });
      expect(response.status()).toBe(201);
    }
    await send(alice,'离线队列末条');
    const directUnread = async () => (await visibleRooms(bob)).find(room=>room.id===direct.id)?.unread;
    await expect.poll(directUnread).toBe(124);
    allowReconnect = true;
    const bobDirect = bob.getByRole('button',{name:'Alice',exact:true});
    await expect(bobDirect).toHaveAccessibleDescription(/124/);
    await expect.poll(directUnread).toBe(124);
    await bob.bringToFront();
    await bobDirect.click();
    await expect(bob.getByText('消息已撤回',{exact:true})).toBeVisible();
    await expect(bob.locator('.message .body').getByText('私聊起点',{exact:true})).toHaveCount(0);
    await expect(bob.locator('.message .body').getByText('离线队列首条',{exact:true})).toHaveCount(1);
    await expect(bob.locator('.message .body').getByText('离线队列末条',{exact:true})).toHaveCount(1);
    await expect(bob.locator('.message .body').getByText(/^离线批次 /)).toHaveCount(122);
    await expect.poll(directUnread).toBe(0);
    await send(bob,'私聊已补齐');
    await expect(alice.locator('.message .body').getByText('私聊已补齐',{exact:true})).toBeVisible();
  } finally {
    try { await browser?.close(); } finally { await stop(); }
  }
});

test('three humans review group invitations, transfer authority and remove access', async () => {
  async function phase(label, body) {
    console.info('group IM: '+label);
    return await test.step(label,body);
  }
  const {origin,ownerKey,stop} = await phase('start split application',launch);
  let browser;
  try {
    browser = await phase('start Chromium',()=>chromium.launch({
      executablePath:process.env.AGENTCHAT_CHROMIUM||undefined,timeout:9000,
    }));
    const [alice,bob,carol] = await phase('open three independent sessions',()=>Promise.all([1,2,3].map(async () => {
      const context=await browser.newContext();
      context.setDefaultTimeout(6000);
      return context.newPage();
    })));
    const api = async (page,path,data) => {
      const response = data===undefined ? await page.request.get(origin+path,{timeout:5000}) : await page.request.post(origin+path,{data,timeout:5000});
      expect(response.ok(), path+' HTTP '+response.status()).toBe(true);
      return response.json();
    };
    const button = (page,name) => page.getByRole('button',{name,exact:true});
    const members = page => page.getByRole('region',{name:'群成员',exact:true});
    const person = (page,name) => members(page).getByRole('listitem').filter({hasText:name});
    const openMembers = async page => {
      await button(page,'成员').click();
      await expect(members(page)).toBeVisible();
    };
    const acceptInvitation = async (page, name) => {
      await button(page,'群聊邀请').click();
      await page.getByRole('listitem').filter({hasText:name}).getByRole('button',{name:'接受群聊邀请',exact:true}).click();
      await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
      await expect(button(page,'群聊邀请')).toHaveAttribute('aria-expanded','false');
    };
    const roomName = '蓝图讨论组';

    await phase('provision users and confirmed friendships',async ()=>{
      await login(alice,origin,ownerKey);
      const {human:bobIdentity,token:bobToken} = await api(alice,'/api/humans',{name:'Bob'});
      const {human:carolIdentity,token:carolToken} = await api(alice,'/api/humans',{name:'Carol'});
      await login(bob,origin,bobToken);
      await login(carol,origin,carolToken);
      await api(alice,'/api/contacts/request',{humanId:bobIdentity.id});
      await api(bob,'/api/contacts/accept',{humanId:'owner'});
      await api(bob,'/api/contacts/request',{humanId:carolIdentity.id});
      await api(carol,'/api/contacts/accept',{humanId:bobIdentity.id});

      await phase('create room and accept initial invitation',async ()=>{

    });

    await button(alice,'新建群聊').click();
      await alice.getByLabel('群聊名称',{exact:true}).fill(roomName);
      await alice.getByRole('checkbox',{name:'Bob',exact:true}).check();
      await button(alice,'创建').click();
      await expect(alice.getByRole('heading',{name:roomName,exact:true})).toBeVisible();
      const managedRoom = (await api(alice,'/api/rooms')).rooms.find(room=>room.name===roomName);
      expect(managedRoom?.managed).toBe(true);
      await expect(button(bob,roomName)).toHaveCount(0);
      await acceptInvitation(bob,roomName);

      await phase('regular member submits reviewed invitation',async ()=>{

    });

    await openMembers(bob);
      await expect(person(bob,'Bob').getByText('成员',{exact:true})).toBeVisible();
      await button(bob,'邀请好友').click();
      await bob.getByLabel('选择好友',{exact:true}).selectOption({label:'Carol'});
      await button(bob,'发送邀请').click();
      await button(carol,'群聊邀请').click();
      await expect(button(carol,'接受群聊邀请')).toHaveCount(0);
      await button(carol,'群聊邀请').click();
      await expect(button(carol,roomName)).toHaveCount(0);

      await phase('owner approves and guest accepts',async ()=>{

    });

    await openMembers(alice);
      await alice.getByRole('listitem').filter({hasText:/Bob.*Carol/}).getByRole('button',{name:'批准邀请',exact:true}).click();
      await acceptInvitation(carol,roomName);
      await openMembers(carol);
      await expect(person(carol,'Carol').getByText('成员',{exact:true})).toBeVisible();
      await expect(button(carol,'批准邀请')).toHaveCount(0);
      await expect(button(carol,'发布公告')).toHaveCount(0);

      await phase('publish announcement and promote admin',async ()=>{

    });

    await alice.getByLabel('公告内容',{exact:true}).fill('周五晚冻结接口。');
      await button(alice,'发布公告').click();
      await expect(carol.getByText('周五晚冻结接口。',{exact:true})).toBeVisible();
      await person(alice,'Bob').getByRole('button',{name:'设为管理员',exact:true}).click();
      await expect(person(bob,'Bob').getByText('管理员',{exact:true})).toBeVisible();
      await expect(person(bob,'Alice').getByRole('button',{name:'移出群聊',exact:true})).toHaveCount(0);
      await expect(person(bob,'Carol').getByRole('button',{name:'移出群聊',exact:true})).toBeVisible();

      await phase('transfer ownership',async ()=>{

    });

    await person(alice,'Bob').getByRole('button',{name:'转让群主',exact:true}).click();
      await button(alice,'确认转让').click();
      await expect(person(bob,'Bob').getByText('群主',{exact:true})).toBeVisible();
      await expect(person(alice,'Alice').getByText('成员',{exact:true})).toBeVisible();
      await expect(alice.getByRole('button',{name:'设为管理员',exact:true})).toHaveCount(0);

      await phase('remove member and verify live access updates',async ()=>{

    });

    await person(bob,'Carol').getByRole('button',{name:'移出群聊',exact:true}).click();
      await button(bob,'确认移出').click();
      await expect(button(carol,roomName)).toHaveCount(0);
      await expect(carol.getByText('周五晚冻结接口。',{exact:true})).toHaveCount(0);
      await expect(carol.getByRole('heading',{name:'General',exact:true})).toBeVisible();
      await send(bob,'交接完成，继续讨论。');
      await expect(alice.locator('.message .body').getByText('交接完成，继续讨论。',{exact:true})).toBeVisible();
    });

  } finally {
    try { await phase('close Chromium',()=>browser?.close()); }
    finally { await phase('stop split application',stop); }
  }
});
