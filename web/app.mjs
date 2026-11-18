import { chooseRoom, createChatPayload, mergeMessages } from './chat-model.mjs';
import { hostStatus, checkStatus, mayRequestCheck, nextCheckRequestId } from './host-model.mjs';
import { icon } from './icons.mjs';

const root = document.querySelector('main');
const state = {
  page: 'chat', session: null, rooms: [], roomId: null, thread: null, mobile: false,
  cursor: null, items: [], hasMore: false, epoch: 0, pending: false,
};
const navigation = [
  ['chat', '群聊'], ['tasks', '项目任务'], ['agents', 'Agent 与设备'],
  ['decisions', '待处理'], ['settings', '设置'],
];
const timestamp = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const messageTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const messageDay = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* UI remains usable */ } },
};
const themes = ['system', 'light', 'dark'];
const feedPositions = new Map();
const drafts = new Map();
let theme = storage.get('workspace.theme');
if (!themes.includes(theme)) theme = 'system';
document.documentElement.dataset.theme = theme;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}
function button(label, action, attrs = {}) {
  return el('button', { type: 'button', ...attrs, onclick: action }, label);
}
function iconButton(label, glyph, action, attrs = {}, withText = false) {
  const control = button('', action, { ...attrs, 'aria-label': label, title: label });
  control.replaceChildren(icon(glyph), ...(withText ? [el('span', {}, label)] : []));
  return control;
}
function brandMark() { return el('div', { class: 'brand', 'aria-hidden': 'true' }, icon('home')); }
function notice(role = 'status') { return el('div', { class: 'notice', role }); }
function field(label, input) { return el('label', {}, label, input); }
function requestId() {
  return globalThis.crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', method: options.method ?? 'GET',
    headers: options.data ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: options.data ? JSON.stringify(options.data) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error ?? `服务返回 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!data) throw new Error('服务返回了无法读取的内容');
  return data;
}
function post(path, data) { return api(path, { method: 'POST', data }); }
function humanTime(value) {
  const date = new Date(value);
  return value != null && !Number.isNaN(date.valueOf()) ? timestamp.format(date) : '';
}
function mountLogin(text = '') {
  state.epoch += 1;
  state.session = null;
  state.items = [];
  state.rooms = [];
  state.roomId = null;
  state.thread = null;
  feedPositions.clear();
  drafts.clear();
  state.mobile = false;
  const info = notice('alert');
  info.textContent = text;
  const input = el('input', { id: 'login-token', type: 'password', autocomplete: 'current-password', required: '', spellcheck: 'false' });
  const submit = el('button', { class: 'primary', type: 'submit' }, '登录');
  const form = el('form', { onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    info.textContent = '';
    try {
      await post('/api/login', { token: input.value });
      input.value = '';
      await bootstrap();
    } catch (error) { info.textContent = error.message; }
    finally { submit.disabled = false; }
  } }, el('div', { class: 'login-heading' }, brandMark(), el('h1', {}, 'Agent Workspace')), field('访问密钥', input), submit, info);
  root.replaceChildren(el('section', { class: 'login', 'aria-label': '登录' }, form));
  if (text) input.focus();
}
async function bootstrap() {
  try {
    const session = await api('/api/session');
    if (!session.user) return mountLogin();
    state.session = session;
    await changePage('chat');
  } catch (error) {
    mountLogin(error.status === 401 ? '' : error.message);
  }
}
let panel;
let shell;
const navControls = new Map();
function frame(page) {
  if (!shell?.isConnected) {
    navControls.clear();
    panel = el('section', { class: 'view' });
    const nav = el('nav', { class: 'nav', 'aria-label': '工作台导航' }, brandMark());
    for (const [id, label] of navigation) {
      const control = iconButton(label, id, () => changePage(id), { class: 'rail-button rail-' + id }, true);
      navControls.set(id, control);
      nav.append(control);
    }
    shell = el('div', { class: 'shell' }, nav, panel);
    root.replaceChildren(shell);
  }
  for (const [id, item] of navControls) {
    if (id === page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  panel.setAttribute('aria-label', navigation.find(row => row[0] === page)[1]);
  panel.dataset.page = page;
  panel.scrollTop = 0;
  panel.replaceChildren(el('div', { class: 'view-loading', role: 'status' }, '正在载入…'));
  return panel;
}
async function changePage(page) {
  if (!state.session) return;
  state.page = page;
  const active = ++state.epoch;
  const target = frame(page);
  try {
    if (page === 'chat') await chatPage(target, active);
    if (page === 'tasks') await tasksPage(target, active);
    if (page === 'agents') await agentsPage(target, active);
    if (page === 'settings') settingsPage(target);
    if (page === 'decisions') await decisionsPage(target, active);
  } catch (error) {
    if (active !== state.epoch) return;
    if (error.status === 401) return mountLogin('登录已失效，请重新登录。');
    target.replaceChildren(el('div', { class: 'page' }, el('p', { role: 'alert' }, error.message), button('重试', () => changePage(page))));
  }
}
function pageFrame(container, title, ...actions) {
  const body = el('div', { class: 'page' }, el('header', { class: 'page-head' },
    el('div', { class: 'page-title' }, el('span', { class: 'overline' }, 'Agent Workspace'), el('h1', {}, title)),
    actions.length ? el('div', { class: 'row' }, ...actions) : null));
  container.replaceChildren(body);
  return body;
}
function listRows(items, child, empty) {
  return items.length ? el('ul', { class: 'list' }, ...items.map(item => el('li', {}, child(item)))) : el('p', { class: 'empty' }, empty);
}
function stateLabel(status) {
  return ({ open: '待处理', pending: '待处理', resolved: '已处理', in_progress: '处理中', review_requested: '待验收', accepted: '已验收', queued: '已排队', planned: '已登记', running: '运行中', completed: '已完成', cancelled: '已取消', offline: '离线', online: '在线', blocked: '受阻', expired: '已失效', idle: '空闲', failed: '失败' })[status] ?? status ?? '未知';
}
async function chatPage(target, epoch) {
  const loaded = await api('/api/rooms');
  if (epoch !== state.epoch) return;
  state.rooms = loaded.rooms;
  state.roomId = chooseRoom(state.rooms, state.roomId ?? storage.get('workspace.room'));
  const roomRows = el('div', { class: 'room-rows' });
  const roomHead = el('div', { class: 'room-section-head' });
  const roomCreate = el('div', { class: 'room-create' });
  const rooms = el('aside', { class: 'room-list', 'aria-label': '群聊列表' },
    el('div', { class: 'workspace-masthead' }, el('span', { class: 'overline' }, '工作台'), el('h2', {}, 'Agent Workspace')),
    el('section', { class: 'room-index' }, roomHead, roomCreate, roomRows),
    el('div', { class: 'workspace-account' }, el('div', { class: 'workspace-account-mark', 'aria-hidden': 'true' },
      Array.from(state.session.user.name)[0] ?? '·'), el('span', {}, state.session.user.name)));
  const chat = el('div', { class: 'chat' }, rooms);
  target.replaceChildren(chat);
  function roomList() {
    const name = el('input', { required: '', maxlength: '80' });
    const info = notice('alert');
    const submit = el('button', { type: 'submit', class: 'primary' }, '创建');
    const add = el('form', { class: 'inline-form', onsubmit: async event => {
      event.preventDefault(); submit.disabled = true;
      try {
        const { room } = await post('/api/rooms', { name: name.value.trim() });
        if (!chat.isConnected) return;
        state.rooms.push(room);
        state.roomId = room.id; state.thread = null; state.mobile = true;
        storage.set('workspace.room', room.id); openRoom();
      } catch (error) { info.textContent = error.message; }
      finally { submit.disabled = false; }
    } }, field('群聊名称', name), submit, info);
    const createToggle = iconButton('新建群聊', 'plus', () => {
      roomCreate.hidden = !roomCreate.hidden;
      createToggle.setAttribute('aria-expanded', String(!roomCreate.hidden));
      if (!roomCreate.hidden) name.focus();
    }, { class: 'icon-button', 'aria-expanded': 'false' });
    roomHead.replaceChildren(el('h2', {}, '群聊'), state.session.user.kind === 'human' ? createToggle : null);
    roomCreate.hidden = true;
    roomCreate.replaceChildren(add);
    roomRows.replaceChildren(...state.rooms.map(room => {
      const control = iconButton(room.name, 'hash', () => {
        state.roomId = room.id;
        state.thread = null;
        state.mobile = true;
        storage.set('workspace.room', room.id);
        openRoom();
        chat.querySelector('h1')?.focus();
      }, { class: 'room', 'aria-current': room.id === state.roomId ? 'true' : null }, true);
      return control;
    }));
    if (!state.rooms.length) roomRows.append(el('p', { class: 'empty' }, '此账户没有可访问的群聊。'));
  }
  function openRoom() {
    const marker = ++state.epoch;
    const room = state.rooms.find(item => item.id === state.roomId);
    const thread = state.thread;
    const roomPath = '/api/rooms/' + encodeURIComponent(state.roomId ?? '');
    const path = roomPath + '/messages';
    const viewKey = roomPath + '/' + (thread?.id ?? '');
    let restoreScroll = true;
    const draft = drafts.get(viewKey) ?? { body: '', mentions: new Set(), replyTo: thread?.id ?? null, retry: null };
    drafts.set(viewKey, draft);
    state.items = [];
    state.cursor = null;
    state.hasMore = false;
    state.pending = false;
    chat.dataset.mobile = state.mobile ? 'conversation' : 'rooms';
    roomList();
    chat.querySelector('.conversation')?.remove();
    if (!room) return;
    const info = notice('status');
    const feed = el('ol', { class: 'feed', 'aria-label': '群聊消息', tabindex: '0', onscroll: () => {
      if (!restoreScroll) {
        if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 16) feedPositions.delete(viewKey);
        else feedPositions.set(viewKey, feed.scrollTop);
      }
    } });
    const input = el('textarea', { 'aria-label': '消息正文', placeholder: '写一条消息…', maxlength: '10000', required: '', rows: '2',
      oninput: () => { draft.body = input.value; },
      onkeydown: event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing && !submit.disabled) {
          event.preventDefault(); input.form.requestSubmit();
        }
      } });
    input.value = draft.body;
    const selected = el('div', { class: 'mention-chips', 'aria-label': '将提醒的成员' });
    const reply = el('div', { class: 'row' });
    const choices = el('div', { id: 'mention-picker', class: 'mention-panel', hidden: '' });
    function setMentionPicker(open, restoreFocus = false) {
      choices.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) choices.querySelector('button')?.focus();
      else if (restoreFocus) toggle.focus();
    }
    const toggle = iconButton('@ 选择成员', 'at', () => setMentionPicker(choices.hidden, true),
      { class: 'composer-mention', 'aria-controls': 'mention-picker', 'aria-expanded': 'false' });
    const submit = el('button', { type: 'submit', class: 'primary send-button', title: '发送（Ctrl / ⌘ + Enter）' }, el('span', {}, '发送'), icon('send'));
    let members = [];
    const agentsById = new Map([state.session.user, ...(state.session.agents ?? [])].map(item => [item.id, item]));
    const selectedActorName = id => agentsById.get(id)?.name ?? id;
    function paintMentions() {
      const previousMemberFocus = choices.contains(document.activeElement) ? document.activeElement.dataset.member : null;
      const shouldRestoreMember = !choices.hidden && (previousMemberFocus || document.activeElement === toggle);
      selected.replaceChildren(...[...draft.mentions].map(id => button(`@${selectedActorName(id)} ×`, () => { draft.mentions.delete(id); paintMentions(); toggle.focus(); }, { class: 'chip', 'aria-label': `移除对 ${selectedActorName(id)} 的提醒` })));
      choices.replaceChildren(...members.map(actor => button(`@${actor.name}`, event => {
        if (draft.mentions.has(actor.id)) draft.mentions.delete(actor.id); else draft.mentions.add(actor.id);
        event.currentTarget.setAttribute('aria-pressed', String(draft.mentions.has(actor.id)));
        selected.replaceChildren(...[...draft.mentions].map(id => button(`@${selectedActorName(id)} ×`, () => { draft.mentions.delete(id); paintMentions(); toggle.focus(); }, { class: 'chip' })));
      }, { 'aria-pressed': String(draft.mentions.has(actor.id)), 'data-member': actor.id })));
      if (!members.length) choices.append(el('span', { class: 'muted' }, '暂无可提及的成员'));
      if (shouldRestoreMember) {
        const controls = [...choices.querySelectorAll('button')];
        (controls.find(control => control.dataset.member === previousMemberFocus) ?? controls[0])?.focus();
      }
    }
    function paintReply() {
      if (!draft.replyTo) return reply.replaceChildren();
      const original = state.items.find(item => item.id === draft.replyTo) ?? thread;
      const name = original?.authorName ?? '消息';
      reply.replaceChildren(el('span', { class: 'muted' }, `回复 ${name}（不自动 @）`), button('取消回复', () => {
        if (thread) { state.thread = null; openRoom(); }
        else { draft.replyTo = null; paintReply(); input.focus(); }
      }, { class: 'subtle' }));
    }
    function messageNode(message) {
      const date = new Date(message.createdAt);
      const time = message.createdAt && Number.isFinite(+date) ? messageTime.format(date) : '';
      const author = message.authorName ?? message.author?.name ?? '成员';
      const top = el('header', {}, el('strong', {}, author),
        (message.authorKind ?? message.author?.kind) === 'agent' ? el('span', { class: 'badge' }, 'Agent') : null,
        time ? el('time', { datetime: new Date(message.createdAt).toISOString() }, time) : null);
      const content = el('div', { class: 'message-content' }, top);
      if (message.replyTo) content.append(el('div', { class: 'muted' }, '回复消息'));
      if (message.mentions?.length) content.append(el('div', { class: 'statuses' }, ...message.mentions.map(id => el('span', { class: 'badge' }, '@' + selectedActorName(id)))));
      content.append(el('p', { class: 'body' }, message.body));
      const actions = el('div', { class: 'row message-actions' }, iconButton('回复', 'reply', () => {
        draft.replyTo = message.replyTo ?? message.id;
        paintReply();
        input.focus();
      }, { class: 'subtle reply' }, true));
      if (!thread && !message.replyTo) actions.append(iconButton('查看线程', 'thread', () => {
        state.thread = message; openRoom(); chat.querySelector('h1')?.focus();
      }, { class: 'subtle reply' }, true));
      content.append(actions);
      return el('li', { class: 'message', 'data-message': message.id }, el('div', { class: 'avatar', 'aria-hidden': 'true' }, Array.from(author.trim())[0] ?? '·'), content);
    }
    function paintFeed() {
      const closeToBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 130;
      const before = feed.scrollTop;
      const activeControl = feed.contains(document.activeElement) ? document.activeElement : null;
      const focusedMessage = activeControl?.closest('[data-message]')?.dataset.message;
      const focusedAction = activeControl?.getAttribute('aria-label');
      const items = document.createDocumentFragment();
      let previousDay;
      for (const message of state.items) {
        const date = new Date(message.createdAt);
        const day = message.createdAt && Number.isFinite(+date) ? messageDay.format(date) : null;
        if (day && day !== previousDay) items.append(el('li', { class: 'day-divider' }, el('span', {}, day)));
        previousDay = day;
        items.append(messageNode(message));
      }
      feed.replaceChildren(items);
      if (!state.items.length) feed.append(el('li', { class: 'chat-empty' },
        el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(thread ? 'thread' : 'hash')),
        el('h2', {}, thread ? '还没有回复' : '这里还没有消息'),
        el('p', {}, thread ? '写一条回复，继续当前讨论。' : '写一条消息开始协作。需要对方接手时，再选中 @ 成员。')));
      if (state.hasMore) feed.append(el('li', { class: 'load-more' }, button('加载更多消息', () => refresh(true))));
      if (focusedMessage && focusedAction) {
        const replacement = [...feed.querySelectorAll('[data-message]')].find(node => node.dataset.message === focusedMessage);
        [...(replacement?.querySelectorAll('button') ?? [])].find(node => node.getAttribute('aria-label') === focusedAction)?.focus({ preventScroll: true });
      }
      if (restoreScroll) {
        feed.scrollTop = feedPositions.get(viewKey) ?? feed.scrollHeight;
        restoreScroll = false;
      } else if (closeToBottom) feed.scrollTop = feed.scrollHeight;
      else feed.scrollTop = before;
    }
    async function refresh(explicit = false) {
      if (marker !== state.epoch || state.pending || (!explicit && state.hasMore)) return;
      state.pending = true;
      const query = new URLSearchParams({ limit: '60' });
      if (state.cursor != null) query.set('after', state.cursor);
      if (thread) query.set('thread', thread.id);
      try {
        const data = await api(path + '?' + query.toString());
        if (marker !== state.epoch) return;
        const first = state.cursor == null;
        const changed = first || data.messages.length > 0 || state.hasMore !== Boolean(data.hasMore);
        state.items = mergeMessages(state.items, data.messages);
        state.cursor = data.nextCursor ?? state.cursor;
        state.hasMore = Boolean(data.hasMore);
        if (changed) paintFeed();
        if (explicit || info.dataset.error === 'refresh') { info.textContent = ''; delete info.dataset.error; }
      } catch (error) {
        if (marker !== state.epoch) return;
        if (error.status === 401) return mountLogin('登录已失效，请重新登录。');
        info.dataset.error = 'refresh';
        info.textContent = `消息未刷新：${error.message}`;
      } finally { if (marker === state.epoch) state.pending = false; }
    }
    const form = el('form', { class: 'composer', onkeydown: event => {
      if (!choices.hidden && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setMentionPicker(false, true);
      }
    }, onsubmit: async event => {
      event.preventDefault();
      let payload;
      try { payload = createChatPayload({ body: input.value, mentions: draft.mentions, replyTo: draft.replyTo }, requestId()); }
      catch (error) { info.textContent = error.message; return; }
      const signature = JSON.stringify({ ...payload, clientRequestId: '' });
      if (draft.retry?.signature === signature) payload.clientRequestId = draft.retry.id;
      draft.retry = { signature, id: payload.clientRequestId };
      submit.disabled = true;
      try {
        await post(path, payload);
        if (marker !== state.epoch) return;
        input.value = '';
        draft.body = '';
        draft.mentions.clear();
        draft.replyTo = thread?.id ?? null;
        draft.retry = null;
        setMentionPicker(false);
        paintMentions(); paintReply();
        info.textContent = '';
        await refresh(true);
      } catch (error) {
        if (marker === state.epoch) {
          info.dataset.error = 'post';
          info.textContent = `未确认发送：${error.message}。保持内容不变重试不会重复创建消息。`;
        }
      } finally { submit.disabled = false; }
    } }, el('div', { class: 'composer-context' }, reply, selected, choices),
      el('div', { class: 'composer-field' }, input, el('div', { class: 'composer-actions' }, toggle, submit)));
    const heading = el('h1', { tabindex: '-1' }, thread ? '线程' : room.name);
    const memberPanel = el('div', { class: 'member-panel', hidden: '' });
    async function refreshMembers() {
      try {
        const result = await api(roomPath + '/members');
        if (marker !== state.epoch) return;
        members = result.members.filter(actor => actor.enabled !== false);
        for (const id of draft.mentions) if (!members.some(actor => actor.id === id)) draft.mentions.delete(id);
        for (const actor of members) agentsById.set(actor.id, actor);
        paintMentions();
        const ids = new Set(members.map(actor => actor.id));
        const alert = notice('alert');
        const rows = el('div', { class: 'stack' }, ...members.filter(actor => actor.kind === 'human').map(actor => el('p', {}, `${actor.name} · 人类`)));
        for (const actor of state.session.agents ?? []) {
          const member = ids.has(actor.id);
          rows.append(el('div', { class: 'row' }, el('span', {}, `${actor.name} · Agent · 所属人类：${state.session.user.name}`),
            state.session.user.kind === 'human' && actor.enabled !== false ? button(member ? '移出群聊' : '加入群聊', async event => {
              const control = event.currentTarget;
              control.disabled = true;
              try { await post(roomPath + '/members', { agentId: actor.id, member: !member }); await refreshMembers(); }
              catch (error) { alert.textContent = error.message; }
              finally { control.disabled = false; }
            }) : null));
        }
        memberPanel.replaceChildren(el('h2', {}, '群成员'), rows, alert);
      } catch (error) {
        if (marker === state.epoch) memberPanel.replaceChildren(el('p', { role: 'alert' }, error.message), button('重试成员列表', () => refreshMembers()));
      }
    }
    const memberButton = iconButton('成员', 'people', () => {
      memberPanel.hidden = !memberPanel.hidden;
      memberButton.setAttribute('aria-expanded', String(!memberPanel.hidden));
      if (!memberPanel.hidden) refreshMembers();
    }, { class: 'icon-button', 'aria-expanded': 'false' });
    const back = iconButton('返回群聊列表', 'arrow', () => { state.mobile = false; chat.dataset.mobile = 'rooms'; rooms.querySelector('[aria-current]')?.focus(); }, { class: 'mobile-back icon-button' });
    const threadBack = thread ? iconButton('返回群聊', 'arrow', () => {
      state.thread = null; openRoom(); chat.querySelector('h1')?.focus();
    }, { class: 'icon-button' }) : null;
    const headingBox = el('div', { class: 'conversation-title' },
      thread ? el('span', { class: 'overline' }, room.name) : null,
      el('div', { class: 'conversation-heading' }, icon(thread ? 'thread' : 'hash'), heading));
    const bar = el('header', { class: 'conversation-bar' },
      el('div', { class: 'conversation-bar-inner' }, back, threadBack, headingBox,
        el('div', { class: 'header-actions' }, memberButton, iconButton('刷新', 'refresh', () => refresh(true), { class: 'icon-button' }))));
    const conversation = el('article', { class: 'conversation' }, bar,
      el('div', { class: 'conversation-context' }, info, memberPanel), feed, el('div', { class: 'composer-dock' }, form));
    chat.append(conversation);
    paintMentions(); paintReply();
    refresh(true);
    refreshMembers();
    state.tick = () => refresh();
  }
  openRoom();
}
function roomSelect(rooms) {
  const select = el('select', { required: '' });
  for (const room of rooms) select.append(el('option', { value: room.id }, room.name));
  if (state.roomId) select.value = state.roomId;
  return select;
}
function expandable(title, form) { return el('details', {}, el('summary', {}, title), form); }
async function tasksPage(target, epoch) {
  const [{ tasks }, { rooms }] = await Promise.all([api('/api/tasks'), api('/api/rooms')]);
  if (epoch !== state.epoch) return;
  const page = pageFrame(target, '项目与任务', button('刷新', () => changePage('tasks')));
  const box = notice('alert');
  if (rooms.length && state.session.user.kind === 'human') {
    const title = el('input', { required: '', maxlength: '160' });
    const description = el('textarea', { maxlength: '3000' });
    const room = roomSelect(rooms);
    const assignee = el('select', {}, el('option', { value: '' }, '暂不指派'));
    for (const actor of [state.session.user, ...(state.session.agents ?? []).filter(actor => actor.enabled)]) {
      assignee.append(el('option', { value: actor.id }, actor.name));
    }
    const submit = el('button', { type: 'submit', class: 'primary' }, '创建任务');
    const form = el('form', { class: 'inline-form', onsubmit: async event => {
      event.preventDefault(); submit.disabled = true;
      const payload = { title: title.value.trim(), description: description.value.trim(), roomId: room.value };
      if (assignee.value) payload.assigneeId = assignee.value;
      try { await post('/api/tasks', payload); if (state.epoch === epoch) await changePage('tasks'); }
      catch (error) { box.textContent = error.message; }
      finally { submit.disabled = false; }
    } }, field('标题', title), field('目标', description), field('来源群聊', room), field('负责人', assignee), submit, box);
    page.append(expandable('新建任务', form));
  }
  const actorNames = new Map([state.session.user, ...(state.session.agents ?? [])].map(actor => [actor.id, actor.name]));
  const transitions = { open: ['in_progress', 'blocked', 'cancelled'], in_progress: ['review_requested', 'blocked', 'cancelled'],
    blocked: ['in_progress', 'cancelled'], review_requested: ['accepted', 'in_progress', 'cancelled'] };
  const labels = { in_progress: '标记处理中', blocked: '标记受阻', cancelled: '取消任务', review_requested: '请求验收', accepted: '验收通过' };
  page.append(listRows(tasks, task => {
    const feedback = notice('alert');
    const actions = el('div', { class: 'row task-actions' });
    const options = Number.isInteger(task.version) ? transitions[task.status] ?? [] : [];
    if (state.session.user.kind === 'human') for (const status of options) actions.append(button(labels[status], async () => {
      for (const control of actions.children) control.disabled = true;
      try {
        await api('/api/tasks/' + encodeURIComponent(task.id), { method: 'PATCH', data: { status, expectedVersion: task.version } });
        if (state.epoch === epoch) await changePage('tasks');
      } catch (error) {
        feedback.textContent = error.status === 409 ? '状态已更新，请刷新任务后重试。' : error.message;
      } finally { for (const control of actions.children) control.disabled = false; }
    }, { class: status === 'cancelled' ? 'task-cancel' : status === options[0] ? 'primary' : 'task-secondary' }));
    return el('div', { class: 'stack' },
      el('div', { class: 'row' }, el('h2', {}, task.title), el('span', { class: 'badge' }, stateLabel(task.status))),
      task.description ? el('p', { class: 'body' }, task.description) : null,
      el('p', { class: 'muted' }, [rooms.find(room => room.id === task.roomId)?.name ?? '', actorNames.get(task.assigneeId) ?? '未指派', humanTime(task.createdAt)].filter(Boolean).join(' · ')),
      task.dependencyIds?.length ? el('p', { class: 'muted' }, '依赖：' + task.dependencyIds.map(id => tasks.find(item => item.id === id)?.title ?? id).join('、')) : null,
      actions, feedback);
  }, '暂无任务。'));
}
async function agentsPage(target, epoch) {
  const owner = state.session.user.kind === 'human';
  const [agentsResult, hostResult] = await Promise.all([api('/api/agents'), owner ? api('/api/hosts') : { hosts: [] }]);
  if (epoch !== state.epoch) return;
  const agents = agentsResult.agents;
  let hosts = hostResult.hosts;
  state.session.agents = agents;
  const page = pageFrame(target, 'Agent 与设备');
  const agentList = el('div');
  const hostList = el('div', { hidden: '' });
  const agentsTab = button('Agent', () => open(false), { 'aria-pressed': 'true' });
  const hostsTab = button('设备', () => open(true), { 'aria-pressed': 'false' });
  const clearDeviceSecret = () => {
    hostList.querySelector('.device-secret')?.replaceChildren();
  };
  function open(device) {
    if (!device) clearDeviceSecret();
    agentList.hidden = device; hostList.hidden = !device;
    agentsTab.setAttribute('aria-pressed', String(!device)); hostsTab.setAttribute('aria-pressed', String(device));
  }
  page.append(el('div', { class: 'row', 'aria-label': '选择 Agent 或设备' }, agentsTab, hostsTab), agentList, hostList);
  const name = el('input', { required: '', maxlength: '80' });
  const alert = notice('alert');
  const submit = el('button', { type: 'submit', class: 'primary' }, '创建 Agent');
  const key = el('div', { hidden: '' });
  const register = el('form', { class: 'inline-form', onsubmit: async event => {
    event.preventDefault(); submit.disabled = true; alert.textContent = ''; key.hidden = true;
    try {
      const output = await post('/api/agents', { name: name.value.trim() });
      if (state.epoch !== epoch) return;
      agents.push(output.agent); name.value = ''; paintAgents();
      if (output.token) {
        key.replaceChildren(el('p', {}, '接入密钥仅在此显示；请保存在该 Agent 的执行环境，不要粘贴到群聊。'),
          el('code', { class: 'secret' }, output.token), button('隐藏密钥', () => { key.replaceChildren(); key.hidden = true; }));
        key.hidden = false;
      }
    } catch (error) { alert.textContent = error.message; }
    finally { submit.disabled = false; }
  } }, field('显示名称', name), submit, alert, key);
  const mutable = el('div');
  function paintAgents() {
    mutable.replaceChildren(listRows(agents, (actor) => {
      const info = notice('alert');
      const toggle = button(actor.enabled ? '停用' : '启用', async () => {
        toggle.disabled = true;
        try {
          const result = await post('/api/agents/' + encodeURIComponent(actor.id) + '/enabled', { enabled: !actor.enabled });
          Object.assign(actor, result.agent);
          if (state.epoch === epoch) paintAgents();
        } catch (error) { info.textContent = error.message; }
        finally { toggle.disabled = false; }
      });
      return el('div', { class: 'stack' },
        el('div', { class: 'row' }, el('h2', {}, actor.name), el('span', { class: 'badge' }, actor.enabled ? '已启用身份' : '已停用身份'), toggle),
        el('p', { class: 'muted' }, '所属人类：' + (actor.ownerId === state.session.user.id ? state.session.user.name : actor.ownerId ?? '未返回')),
        info);
    }, '暂无 Agent 身份。'));
  }
  agentList.append(expandable('添加 Agent', register), mutable); paintAgents();
  if (!owner) {
    hostList.append(el('p', { class: 'empty' }, '只有所属账户可以管理设备。'));
    return;
  }
  const hostRows = el('div');
  const listError = notice('alert');
  const openDetails = new Set();
  const retryIds = new Map();
  const busyHosts = new Set();
  const checkEpoch = new Map();
  const hostName = el('input', { required: '', maxlength: '100' });
  const hostError = notice('alert');
  const hostKey = el('div', { class: 'device-secret' });
  const hostSubmit = el('button', { type: 'submit', class: 'primary' }, '登记设备');
  const hostRegister = el('form', { class: 'inline-form', onsubmit: async event => {
    event.preventDefault();
    hostSubmit.disabled = true;
    hostError.textContent = '';
    clearDeviceSecret();
    try {
      const output = await post('/api/hosts', { name: hostName.value.trim() });
      if (state.epoch !== epoch) return;
      hosts = [output.host, ...hosts];
      hostName.value = '';
      paintHosts();
      if (!hostList.hidden) hostKey.replaceChildren(el('p', {}, '密钥只显示一次，请在设备上安全保存。未连接之前，登记不代表设备在线。'),
        el('code', { class: 'secret' }, output.token), button('忘记此密钥', clearDeviceSecret));
    } catch (error) { hostError.textContent = error.message; }
    finally { hostSubmit.disabled = false; }
  } }, field('设备名称', hostName), hostSubmit, hostError, hostKey);
  const hostRegisterBox = expandable('登记新设备', hostRegister);
  hostRegisterBox.addEventListener('toggle', () => { if (!hostRegisterBox.open) clearDeviceSecret(); });
  async function reloadHosts() {
    try {
      hosts = (await api('/api/hosts')).hosts;
      if (state.epoch === epoch) { paintHosts(); listError.textContent = ''; }
    } catch (error) { listError.textContent = error.message; }
  }
  const refreshDevices = button('刷新设备', async () => {
    refreshDevices.disabled = true;
    try { await reloadHosts(); } finally { refreshDevices.disabled = false; }
  });
  let hostRowGeneration = 0;
  function paintHosts() {
    const render = ++hostRowGeneration;
    hostRows.replaceChildren(listRows(hosts, host => {
      const path = '/api/hosts/' + encodeURIComponent(host.id);
      const panel = el('div', { class: 'stack' });
      const checkRows = el('div');
      const info = notice('status');
      const controls = el('div', { class: 'row' });
      async function showChecks() {
        const call = (checkEpoch.get(host.id) ?? 0) + 1;
        checkEpoch.set(host.id, call);
        const current = () => hostRowGeneration === render && checkEpoch.get(host.id) === call && state.epoch === epoch;
        try {
          const { checks } = await api(path + '/status-checks');
          if (!current()) return;
          checkRows.replaceChildren(listRows(checks, check => {
            const result = check.status === 'completed' && check.result;
            return el('div', { class: 'stack' },
              el('div', { class: 'row' }, el('span', { class: 'badge' }, checkStatus(check.status)), el('time', {}, humanTime(check.createdAt))),
              result ? el('p', { class: 'muted' }, `系统：${result.platform} · Connector：${result.connectorVersion}`) : null);
          }, '暂无状态检查。'));
        } catch (error) {
          if (current()) info.textContent = `无法读取状态检查：${error.message}`;
        }
      }
      const details = expandable('连接详情', panel);
      details.open = openDetails.has(host.id);
      details.addEventListener('toggle', () => {
        if (hostRowGeneration !== render) return;
        if (details.open) { openDetails.add(host.id); showChecks(); } else openDetails.delete(host.id);
      });
      const request = button('请求只读检查', async () => {
        if (busyHosts.has(host.id)) return;
        busyHosts.add(host.id);
        request.disabled = true;
        const clientRequestId = nextCheckRequestId(retryIds.get(host.id), requestId);
        retryIds.set(host.id, clientRequestId);
        info.textContent = '';
        try {
          const { check } = await post(path + '/status-checks', { clientRequestId });
          retryIds.delete(host.id);
          info.textContent = checkStatus(check.status);
          await showChecks();
        } catch (error) {
          if (error.status && error.status < 500) retryIds.delete(host.id);
          info.textContent = `未确认创建检查：${error.message}`;
        } finally { busyHosts.delete(host.id); request.disabled = false; }
      });
      if (mayRequestCheck(host.status)) controls.append(request);
      controls.append(button('刷新回执', () => showChecks()));
      if (host.status !== 'revoked') {
        const confirmBox = el('div', { class: 'row', hidden: '' });
        const revoke = button('撤销设备', () => { confirmBox.hidden = false; confirmed.focus(); });
        const confirmed = button('确认撤销', async () => {
          if (busyHosts.has(host.id)) return;
          busyHosts.add(host.id);
          confirmed.disabled = true;
          try {
            const { host: updated } = await post(path + '/revoke', {});
            hosts = hosts.map(item => item.id === updated.id ? updated : item);
            if (state.epoch === epoch) paintHosts();
          } catch (error) { info.textContent = error.message; }
          finally { busyHosts.delete(host.id); confirmed.disabled = false; }
        });
        confirmBox.append(el('span', {}, '撤销此设备密钥后，它将无法继续连接。'), confirmed,
          button('返回', () => { confirmBox.hidden = true; revoke.focus(); }, { class: 'subtle' }));
        controls.append(revoke);
        panel.append(controls, confirmBox);
      } else panel.append(controls);
      panel.append(info, checkRows);
      if (details.open) showChecks();
      return el('div', { class: 'stack' },
        el('div', { class: 'row' }, el('h2', {}, host.name ?? host.id), el('span', { class: 'badge' }, hostStatus(host.status))),
        host.lastSeenAt ? el('p', { class: 'muted' }, '最近连接：' + humanTime(host.lastSeenAt)) : null, details);
    }, '暂无已登记设备。'));
  }
  hostList.append(el('div', { class: 'row' }, refreshDevices), listError, hostRegisterBox, hostRows);
  paintHosts();
}
async function decisionsPage(target, epoch) {
  const [{ decisions }, { rooms }] = await Promise.all([api('/api/decisions'), api('/api/rooms')]);
  if (epoch !== state.epoch) return;
  const page = pageFrame(target, '待处理', button('刷新', () => changePage('decisions')));
  if (rooms.length) {
    const room = roomSelect(rooms);
    const question = el('input', { required: '', maxlength: '200' });
    const options = el('textarea', { required: '', placeholder: '每行一个选项', maxlength: '700' });
    const submit = el('button', { type: 'submit', class: 'primary' }, '创建事项');
    const info = notice('alert');
    const form = el('form', { class: 'inline-form', onsubmit: async event => {
      event.preventDefault(); submit.disabled = true;
      try {
        const choices = [...new Set(options.value.split('\n').map(s => s.trim()).filter(Boolean))];
        if (choices.length < 2) throw new Error('请输入至少两个不同选项。');
        await post('/api/decisions', { roomId: room.value, question: question.value.trim(), options: choices });
        if (state.epoch === epoch) await changePage('decisions');
      } catch (error) { info.textContent = error.message; }
      finally { submit.disabled = false; }
    } }, field('来源群聊', room), field('问题', question), field('可选答案', options), submit, info);
    page.append(expandable('新建决定事项', form));
  }
  page.append(listRows(decisions, decision => {
    const inline = notice('alert');
    const actions = el('div', { class: 'row' });
    if (['open', 'pending'].includes(decision.status)) {
      for (const choice of decision.options ?? []) actions.append(button(String(choice), async () => {
        for (const item of actions.children) item.disabled = true;
        try {
          await post('/api/decisions/' + encodeURIComponent(decision.id) + '/resolve', { response: choice });
          if (state.epoch === epoch) await changePage('decisions');
        } catch (error) { inline.textContent = error.message; }
        finally { for (const item of actions.children) item.disabled = false; }
      }));
    }
    return el('div', { class: 'stack' },
      el('div', { class: 'row' }, el('h2', {}, decision.question), el('span', { class: 'badge' }, stateLabel(decision.status))),
      decision.response != null ? el('p', {}, '已选：' + decision.response) : null,
      el('p', { class: 'muted' }, (rooms.find(room => room.id === decision.roomId)?.name ?? '') + (decision.taskRef ? ' · 关联任务 ' + decision.taskRef : '')),
      actions, inline);
  }, '暂无决定事项。'));
}
function settingsPage(target) {
  const info = notice('alert');
  const page = pageFrame(target, '设置');
  const choice = el('select', { onchange: () => {
    if (!themes.includes(choice.value)) return;
    theme = choice.value;
    document.documentElement.dataset.theme = theme;
    storage.set('workspace.theme', theme);
  } }, ...[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) => el('option', { value }, label)));
  choice.value = theme;
  page.append(el('div', { class: 'inline-form' },
    el('h2', {}, '当前账户'), el('p', {}, state.session.user.name),
    field('本设备主题', choice),
    button('退出登录', async () => {
      try { await post('/api/logout', {}); mountLogin(); }
      catch (error) { info.textContent = error.message; }
    }), info));
}
globalThis.setInterval(() => {
  if (state.session && state.page === 'chat' && document.visibilityState !== 'hidden') state.tick?.();
}, 5000);
bootstrap();
