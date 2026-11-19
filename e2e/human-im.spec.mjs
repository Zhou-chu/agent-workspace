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
