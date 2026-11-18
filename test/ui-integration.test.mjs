import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createWorkspaceServer } from '../server/index.mjs';
import { openWorkspace } from '../server/workspace.mjs';

async function harness(t) {
  const token = randomBytes(32).toString('hex');
  const store = openWorkspace(':memory:', 'Test owner');
  const server = createWorkspaceServer({ store, ownerToken: token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const nativeFetch = globalThis.fetch;
  const page = await nativeFetch(origin);
  assert.equal(page.status, 200);
  const dom = new JSDOM(await page.text(), { url: origin, pretendToBeVisual: true });
  t.after(() => dom.window.close());
  let cookie, tick, intercept = null;
  const requests = [];
  function substitute(name, value) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (saved) Object.defineProperty(globalThis, name, saved);
      else delete globalThis[name];
    });
  }
  substitute('document', dom.window.document);
  substitute('localStorage', dom.window.localStorage);
  // Capture the app's periodic refresh and trigger it deliberately when needed.
  // Do not let a wall-clock poll race with an explicitly tested UI operation.
  substitute('setInterval', callback => { tick = callback; return 0; });
  substitute('fetch', async (path, options) => {
    const headers = { ...options.headers };
    if (cookie) headers.Cookie = cookie;
    if (options.method !== 'GET') headers.Origin = origin;
    const call = { path, method: options.method, body: options.body ? JSON.parse(options.body) : null };
    requests.push(call);
    const work = async () => {
      const res = await nativeFetch(origin + path, { ...options, headers });
      if (res.headers.get('Set-Cookie')) cookie = res.headers.get('Set-Cookie').split(';')[0];
      return res;
    };
    return intercept ? intercept(call, work) : work();
  });

  const d = dom.window.document;
  const wait = (predicate, label) => new Promise((resolve, reject) => {
    const observer = new dom.window.MutationObserver(check);
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('DOM condition not reached: ' + label)); }, 3500);
    function check() {
      try {
        const value = predicate();
        if (!value) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve(value);
      } catch (error) {
        clearTimeout(timeout);
        observer.disconnect();
        reject(error);
      }
    }
    observer.observe(d.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
    check();
  });
  const named = (selector, label) => [...d.querySelectorAll(selector)].find(node => node.textContent.trim() === label);
  const find = (selector, label) => wait(() => named(selector, label), label);
  const element = selector => wait(() => d.querySelector(selector), selector);
  const click = async (label, selector = 'button') => (await find(selector, label)).click();
  const text = value => wait(() => d.body.textContent.includes(value), value);
  const field = (label, value) => {
    const labelNode = [...d.querySelectorAll('label')].find(node =>
      [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent).join('').trim() === label);
    const input = labelNode?.querySelector('input, textarea, select') ?? [...d.querySelectorAll('input[aria-label], textarea[aria-label], select[aria-label]')].find(node => node.getAttribute('aria-label') === label);
    assert.ok(input, label);
    input.value = value;
    return input;
  };
  const submit = selector => {
    const form = typeof selector === 'string' ? d.querySelector(selector) : selector;
    assert.ok(form);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  };
  const deviceCall = async (auth, path, body) => {
    const res = await nativeFetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return [res.status, await res.json()];
  };
  await import('../web/app.mjs');
  await element('#login-token');
  async function login(secret = token) {
    field('访问密钥', secret);
    submit('.login form');
  }
  return {
    dom, d, requests, wait, named, find, element, click, text, field, submit, deviceCall, login,
    intercept(handler) { intercept = handler; },
    tick() { tick(); },
    invalidateCookie() { cookie = 'workspace_session=expired'; },
  };
}

async function createAgent(h) {
  await h.click('◇Agent 与设备');
  await h.click('添加 Agent', 'summary');
  h.submit(h.field('显示名称', 'Alpha').form);
  const key = (await h.element('.secret')).textContent;
  await h.click('隐藏密钥');
  assert.equal(h.d.body.textContent.includes(key), false);
  return key;
}

test('workspace UI integrates with HTTP and SQLite across one owner session', async t => {
  const h = await harness(t);
  await t.test('chat uses room membership, explicit mentions and safe idempotent retry', async () => {
    await h.login('wrong-synthetic-key');
    await h.wait(() => h.d.querySelector('.login [role=alert]').textContent.length > 0, 'login fails');
    await h.login();
    await h.element('.composer');
    const agentKey = await createAgent(h);
    await h.click('停用');
    await h.find('.badge', '已停用身份');
    await h.click('启用');
    await h.find('.badge', '已启用身份');
    await h.click('□群聊');
    await h.click('新建群聊', 'summary');
    h.submit(h.field('群聊名称', 'Side room').form);
    await h.find('h1', 'Side room');
    await h.click('成员');
    await h.click('加入群聊');
    await h.find('button', '移出群聊');
    await h.click('成员');

    let loseResponse = true;
    const sends = [];
    h.intercept(async (call, work) => {
      if (call.method !== 'POST' || !call.path.endsWith('/messages')) return work();
      sends.push(call.body);
      const res = await work();
      if (!loseResponse) return res;
      loseResponse = false;
      await res.json();
      throw new Error('test network drop after server commit');
  });
  function beginSend(value) { h.submit(h.field('消息正文', value).form); }
  const literal = 'ordinary @Alpha <script>not executable</script>';
  beginSend(literal);
  await h.text('未确认发送');
  beginSend(literal);
  const rendered = await h.find('.message .body', literal);
  assert.equal(rendered.children.length, 0);
  assert.deepEqual(sends.map(v => v.clientRequestId), [sends[0].clientRequestId, sends[0].clientRequestId]);
  assert.equal([...h.d.querySelectorAll('.message .body')].filter(v => v.textContent === literal).length, 1);

  await h.click('回复');
  await h.click('取消回复');
  await h.click('回复');
  beginSend('plain reply');
  await h.find('.message .body', 'plain reply');
  assert.ok(sends.at(-1).replyTo);
  const reminders = async () => (await h.deviceCall(agentKey, '/api/reminders'))[1].reminders;
  assert.equal((await reminders()).length, 0);

  await h.click('查看线程');
  await h.find('h1', '线程');
  await h.find('.message .body', 'plain reply');
  await h.click('返回群聊');
  await h.find('h1', 'Side room');
  await h.click('@ 选择成员');
  await h.click('@Alpha');
  await h.click('@Alpha ×');
  await h.click('@Alpha');
  beginSend('explicit mention');
  await h.find('.message .body', 'explicit mention');
  assert.equal((await reminders()).length, 1);
  assert.equal(sends.at(-1).mentions.length, 1);
  await h.click('成员');
  await h.click('移出群聊');
  await h.find('button', '加入群聊');
  });
  h.intercept(null);
  await t.test('decision, versioned task lifecycle and local settings remain usable', async () => {
    await h.click('✓待处理');
    await h.click('新建决定事项', 'summary');
    h.field('问题', 'Choose a review outcome');
    h.submit(h.field('可选答案', 'A').form);
    await h.text('请输入至少两个');
    h.submit(h.field('可选答案', 'A\nB').form);
    await h.click('B');
    await h.text('已选：B');
    await h.click('≡项目任务');
    await h.click('新建任务', 'summary');
    h.field('目标', 'Document the completed review.');
    h.submit(h.field('标题', 'Review follow-up').form);
    await h.find('h2', 'Review follow-up');
    await h.click('标记处理中');
    await h.find('.badge', '处理中');
    await h.click('请求验收');
    await h.find('.badge', '待验收');
    await h.click('验收通过');
    await h.find('.badge', '已验收');
    await h.click('⊙设置');
    const select = h.field('本设备主题', 'dark');
    select.dispatchEvent(new h.dom.window.Event('change'));
    assert.equal(h.d.documentElement.dataset.theme, 'dark');
    assert.equal(h.dom.window.localStorage.getItem('workspace.theme'), 'dark');
    await h.click('退出登录');
    await h.element('#login-token');
    assert.equal(h.dom.window.localStorage.getItem('workspace.theme'), 'dark');
  });
  await t.test('host dashboard only queues manual status for online devices and verifies revocation', async () => {
    await h.login();
    await h.element('.composer');
    await h.click('◇Agent 与设备');
    await h.click('设备');
    await h.click('登记新设备', 'summary');
    h.submit(h.field('设备名称', 'Synthetic runner').form);
    const key = (await h.element('.device-secret .secret')).textContent;
    assert.match(key, /^aw_host_/);
    await h.find('.badge', '尚未连接');
    assert.equal(h.named('button', '请求只读检查'), undefined);
    await h.click('忘记此密钥');
    assert.equal(h.d.body.textContent.includes(key), false);

    const host = (path, body) => h.deviceCall(key, path, body);
    assert.equal((await host('/api/host/heartbeat', {}))[0], 200);
    await h.click('刷新设备');
    await h.find('.badge', '在线');
    await h.click('连接详情', 'summary');
    await h.click('请求只读检查');
    await h.find('.badge', '等待设备领取');
    const [claimed, result] = await host('/api/host/status-checks/claim', { requestId: 'claim-1' });
    assert.equal(claimed, 200);
    await h.click('刷新回执');
    await h.find('.badge', '已领取，等待回执');
    const check = result.check;
    assert.equal((await host('/api/host/status-checks/' + check.id + '/ack', {
      receiptId: check.receiptId,
      result: { platform: 'linux', connectorVersion: '0.1.0' },
    }))[0], 200);
    await h.click('刷新回执');
    await h.find('.badge', '已收到回执');
    await h.text('系统：linux · Connector：0.1.0');

    await h.click('撤销设备');
    await h.click('返回');
    assert.equal((await host('/api/host/heartbeat', {}))[0], 200);
    await h.click('撤销设备');
    await h.click('确认撤销');
    await h.find('.badge', '已撤销');
    assert.equal(h.named('button', '请求只读检查'), undefined);
    assert.equal((await host('/api/host/heartbeat', {}))[0], 401);
  });
  await t.test('failed reads display a retry path and expired sessions return to login', async () => {
    h.intercept((call, work) => call.path === '/api/tasks'
      ? new Response(JSON.stringify({ error: 'test service error' }), { status: 503 }) : work());
    await h.click('≡项目任务');
    await h.text('test service error');
    h.intercept(null);
    await h.click('重试');
    await h.find('h2', 'Review follow-up');
    await h.click('□群聊');
    await h.find('.message .body', 'explicit mention');
    h.intercept((call, work) => call.method === 'GET' && call.path.includes('/messages?')
      ? new Response(JSON.stringify({ error: 'test connection unavailable' }), { status: 503 }) : work());
    await h.click('刷新');
    await h.text('消息未刷新');
    assert.ok(h.named('.message .body', 'explicit mention'));
    h.intercept(null);
    h.invalidateCookie();
    h.tick();
    await h.text('登录已失效，请重新登录。');
    await h.element('#login-token');
    assert.equal(h.d.body.textContent.includes('explicit mention'), false);
  });
});
