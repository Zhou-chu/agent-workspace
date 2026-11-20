import { chooseRoom, collectRoomPages, contactAction, createChatPayload, mergeMessages, visibleReadCursor } from './chat-model.mjs';
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
function uploadAttachment(path, file, kind, id) {
  return api(path, {method:'POST',raw:file,headers:{
    'Content-Type':file.type||'application/octet-stream','X-AgentChat-Media-Kind':kind,
    'X-AgentChat-File-Name':encodeURIComponent(file.name),'X-AgentChat-Request-Id':id,
  }});
}
let imSocket;
let imRetry;
let failures=0;
function stopRealtime() {
  clearTimeout(imRetry);
  const socket=imSocket;
  imSocket=undefined;
  failures=0;
  socket?.close();
}
function startRealtime() {
  if(!state.session?.imRealtime||imSocket||typeof WebSocket!=='function') return;
  const url=new URL('/ws',document.URL);
  url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const socket=imSocket=new WebSocket(url);
  socket.addEventListener('open',()=>{
    if(socket!==imSocket) return;
    failures=0;
    if(state.page==='chat') state.reconcile?.();
  });
  socket.addEventListener('message',({data})=>{
    if(socket!==imSocket || state.page!=='chat') return;
    let event;
    try { event=JSON.parse(data); } catch { return; }
    if(event?.type==='room.changed'&&typeof event.roomId==='string') {
      state.refreshRooms?.();
      if(event.roomId===state.roomId) state.sync?.();
    }
    if(event?.type==='read.changed') state.refreshRooms?.();
    if(event?.type==='contacts.changed') state.refreshContacts?.();
  });
  socket.addEventListener('close',()=>{
    if(socket!==imSocket) return;
    imSocket=undefined;
    if(state.session?.imRealtime) imRetry=setTimeout(startRealtime,Math.min(3000,200*2**failures++));
  });
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', method: options.method ?? 'GET',
    headers: options.headers ?? (options.data ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }),
    body: options.raw ?? (options.data ? JSON.stringify(options.data) : undefined),
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
  stopRealtime();
  state.epoch += 1;
  state.stopRecording?.();
  state.stopRecording=undefined;
  state.session = null;
  state.reconcile = state.refreshRooms = state.refreshContacts = state.sync = state.tick = undefined;
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
  } }, el('div', { class: 'login-heading' }, brandMark(), el('h1', {}, 'AgentChat')), field('访问密钥', input), submit, info);
  root.replaceChildren(el('section', { class: 'login', 'aria-label': '登录' }, form));
  if (text) input.focus();
}
async function bootstrap() {
  try {
    const session = await api('/api/session');
    if (!session.user) return mountLogin();
    state.session = session;
    await changePage('chat');
    startRealtime();
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
      if(state.session.imRealtime && state.session.user.id!=='owner'&&!['chat','settings'].includes(id)) continue;
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
  state.stopRecording?.();
  state.stopRecording=undefined;
  state.reconcile = state.refreshRooms = state.refreshContacts = state.sync = state.tick = undefined;
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
    el('div', { class: 'page-title' }, el('span', { class: 'overline' }, 'AgentChat'), el('h1', {}, title)),
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
function contactsPanel(active, openDirect) {
  const panel = el('section', {id:'chat-contacts', class:'contact-panel', 'aria-label':'联系人', hidden:''});
  const info = notice('status');
  const lists = el('div', {class:'contact-sections'});
  const results = el('div', {class:'contact-sections'});
  const query = el('input',{type:'search',maxlength:'80',required:''});
  const submit = el('button',{type:'submit',class:'subtle'},'搜索');
  let serial = 0;
  let contacts = {friends:[],incoming:[],outgoing:[]};
  let search;
  let pending = false;
  let refreshPending = false, refreshQueued = false;
  const opened = () => active() && !panel.hidden;
  const report = error => {if(opened()) info.textContent=error.message;};
  const restoreAction = (container, render) => {
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const id = focused?.dataset.contact;
    render();
    if(id) [...container.querySelectorAll('button')].find(node=>node.dataset.contact===id)?.focus({preventScroll:true});
  };
  function item(person, status) {
    const action = contactAction(status);
    return el('div',{class:'contact-item'},el('span',{},person.name),
      action ? button(action.label, async event=>{
        if(pending) return;
        pending=true;
        const control=event.currentTarget;
        control.disabled=true;
        info.textContent='';
        try {
          const response=await post(action.path,{humanId:person.id});
          if(!opened()) return;
          if(response.room) {openDirect(response.room);return;}
          info.textContent=status==='incoming'?'已接受好友申请。':'已发出好友申请。';
          await refresh();
        } catch(error) {report(error);}
        finally {pending=false;control.disabled=false;}
      },{class:'subtle','data-contact':person.id}) :
      status==='outgoing' ? el('span',{class:'muted'},'等待确认') : null);
  }
  function panelGroup(title, people, status, empty) {
    return el('section',{},el('h3',{},title),listRows(people,person=>item(person,status??person.status),empty));
  }
  function paintContacts() {
    restoreAction(lists,()=>lists.replaceChildren(
      panelGroup('收到的申请',contacts.incoming,'incoming','暂无申请'),
      panelGroup('发出的申请',contacts.outgoing,'outgoing','暂无申请'),
      panelGroup('好友',contacts.friends,'friend','暂无好友')));
  }
  async function searchPeople(value) {
    const attempt=++serial;
    try {
      const {people}=await api('/api/contacts/search?'+new URLSearchParams({q:value}));
      if(attempt!==serial||!opened()) return;
      restoreAction(results,()=>results.replaceChildren(panelGroup('搜索结果',people,null,'未找到用户')));
    } catch(error) {if(attempt===serial) report(error);}
  }
  async function refresh() {
    if(!opened()) return;
    if(refreshPending){refreshQueued=true;return;}
    refreshPending=true;
    try {
      const next=await api('/api/contacts');
      if(!opened()) return;
      if(JSON.stringify(next)!==JSON.stringify(contacts)||!lists.childElementCount) {contacts=next;paintContacts();}
      if(search) await searchPeople(search);
    } catch(error) {report(error);}
    finally {
      refreshPending=false;
      if(refreshQueued){refreshQueued=false;void refresh();}
    }
  }
  const toggle = iconButton('联系人','people',()=>{
    panel.hidden=!panel.hidden;
    toggle.setAttribute('aria-expanded',String(!panel.hidden));
    if(opened()){query.focus();void refresh();}
  },{class:'icon-button','aria-expanded':'false','aria-controls':panel.id});
  function close() {panel.hidden=true;toggle.setAttribute('aria-expanded','false');serial++;}
  panel.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.stopPropagation();close();toggle.focus();}
  });
  panel.append(el('form',{class:'contact-search',onsubmit:async event=>{
    event.preventDefault();
    search=query.value.trim();
    if(!search) return;
    info.textContent='';
    submit.disabled=true;
    try {await searchPeople(search);} finally {submit.disabled=false;}
  }},field('搜索用户',query),submit),info,results,lists);
  return {toggle,panel,refresh,close};
}

async function chatPage(target, epoch) {
  const loaded = await api('/api/rooms');
  if (epoch !== state.epoch) return;
  state.rooms = loaded.rooms;
  state.roomId = chooseRoom(state.rooms, state.roomId ?? storage.get('workspace.room'));
  const roomRows = el('div', { class: 'room-rows' });
  const roomHead = el('div', { class: 'room-section-head' });
  const roomCreate = el('div', { class: 'room-create' });
  const modern = state.session.imRealtime === true;
  const contacts = modern && state.session.user.kind==='human'
    ? contactsPanel(()=>chat.isConnected && state.page==='chat',room=>{
      if(!state.rooms.some(item=>item.id===room.id)) state.rooms.push(room);
      contacts.close();
      selectRoom(room.id);
      void refreshRooms();
    }) : null;
  const rooms = el('aside', { class: 'room-list', 'aria-label': modern ? '会话列表' : '群聊列表' },
    el('div', { class: 'workspace-masthead' }, el('span', { class: 'overline' }, '工作台'), el('h2', {}, 'AgentChat')),
    el('section', { class: 'room-index' }, roomHead, roomCreate, contacts?.panel, roomRows),
    el('div', { class: 'workspace-account' }, el('div', { class: 'workspace-account-mark', 'aria-hidden': 'true' },
      Array.from(state.session.user.name)[0] ?? '·'), el('span', {}, state.session.user.name)));
  const chat = el('div', { class: 'chat' }, rooms);
  target.replaceChildren(chat);
  function selectRoom(id) {
    state.roomId = id;
    state.thread = null;
    state.mobile = true;
    storage.set('workspace.room',id);
    openRoom();
    chat.querySelector('h1')?.focus();
  }
  const activeChat = () => chat.isConnected && state.page==='chat';
  function paintRooms() {
    const focused = roomRows.contains(document.activeElement) ? document.activeElement.dataset.room : null;
    roomRows.replaceChildren(...state.rooms.map((room,index) => {
      const unread = Number.isSafeInteger(room.unread) && room.unread>0 ? room.unread : 0;
      const badgeId = 'chat-unread-'+index;
      const name = room.peer?.name ?? room.name;
      const control = iconButton(name, room.kind==='direct'?'chat':'hash', () => selectRoom(room.id), {
        class:'room', 'data-room':room.id, 'aria-current':room.id===state.roomId?'true':null,
        'aria-describedby':unread?badgeId:null,
      }, true);
      if(unread) control.append(el('span',{class:'room-unread','data-unread':unread, 'aria-hidden':'true'},unread>99?'99+':String(unread)));
      return el('div',{},control,unread?el('span',{id:badgeId,hidden:''},unread+' 条未读消息'):null);
    }));
    if(focused) [...roomRows.querySelectorAll('button')].find(control=>control.dataset.room===focused)?.focus({preventScroll:true});
    if (!state.rooms.length) roomRows.append(el('p', { class: 'empty' }, modern?'暂无会话。':'此账户没有可访问的群聊。'));
  }
  let loadingRooms=false, roomRefreshQueued=false;
  async function refreshRooms() {
    if(!activeChat()||!modern) return;
    if(loadingRooms){roomRefreshQueued=true;return;}
    loadingRooms=true;
    try {
      const {rooms:next}=await api('/api/rooms');
      if(!activeChat()||roomRefreshQueued) return;
      if(JSON.stringify(next)===JSON.stringify(state.rooms)) return;
      state.rooms=next;
      if(!next.some(room=>room.id===state.roomId)) {
        state.roomId=chooseRoom(next,null);
        state.thread=null;
        openRoom();
      } else paintRooms();
    } catch(error) {
      if(activeChat()&&error.status===401) mountLogin('登录已失效，请重新登录。');
    } finally {
      loadingRooms=false;
      if(roomRefreshQueued){roomRefreshQueued=false;void refreshRooms();}
    }
  }
  function setRoomControls() {
    const name = el('input', { required: '', maxlength: '80' });
    const info = notice('alert');
    const submit = el('button', { type: 'submit', class: 'primary' }, '创建');
    const add = el('form', { class: 'inline-form', onsubmit: async event => {
      event.preventDefault(); submit.disabled = true;
      try {
        const { room } = await post('/api/rooms', { name: name.value.trim() });
        if (!chat.isConnected) return;
        state.rooms.push(room);
        roomCreate.hidden=true;
        createToggle.setAttribute('aria-expanded','false');
        selectRoom(room.id);
        void refreshRooms();
      } catch (error) { info.textContent = error.message; }
      finally { submit.disabled = false; }
    } }, field('群聊名称', name), submit, info);
    const createToggle = iconButton('新建群聊', 'plus', () => {
      roomCreate.hidden = !roomCreate.hidden;
      createToggle.setAttribute('aria-expanded', String(!roomCreate.hidden));
      if (!roomCreate.hidden) name.focus();
    }, { class: 'icon-button', 'aria-expanded': 'false' });
    roomHead.replaceChildren(el('h2', {}, modern?'会话':'群聊'), el('div',{class:'row room-actions'},
      contacts?.toggle, state.session.user.id === 'owner' ? createToggle : null));
    roomCreate.hidden = true;
    roomCreate.replaceChildren(add);
  }
  setRoomControls();
  state.refreshRooms=refreshRooms;
  state.refreshContacts=contacts?.refresh;
  state.reconcile=()=>{void refreshRooms();void contacts?.refresh();state.sync?.();};
  function openRoom() {
    const marker = ++state.epoch;
    state.stopRecording?.();
    state.stopRecording=undefined;
    const room = state.rooms.find(item => item.id === state.roomId);
    const thread = state.thread;
    const direct = room?.kind==='direct';
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
    paintRooms();
    state.tick=state.sync=undefined;
    chat.querySelector('.conversation')?.remove();
    if (!room) return;
    const info = notice('status');
    const feed = el('ol', { class: 'feed', 'aria-label': direct?'私聊消息':'群聊消息', tabindex: '0', onscroll: () => {
      acknowledgeRead();
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
      if(message.retractedAt) {
        content.append(el('p',{class:'muted'},'消息已撤回'));
        return el('li',{class:'message','data-message':message.id},content);
      }
      if(message.body) content.append(el('p', { class: 'body' }, message.body));
      if(message.attachment) {
        const {kind,name}=message.attachment;
        const src=path+'/'+encodeURIComponent(message.id)+'/attachment';
        if(kind==='image') content.append(el('img',{class:'chat-image',alt:name,src,loading:'lazy'}));
        if(kind==='file') content.append(el('a',{href:src,download:''},'下载 '+name));
        if(kind==='voice') content.append(el('audio',{src,controls:'',preload:'metadata','aria-label':'语音消息'}));
      }
      const actions = el('div', { class: 'row message-actions' }, iconButton('回复', 'reply', () => {
        draft.replyTo = message.replyTo ?? message.id;
        paintReply();
        input.focus();
      }, { class: 'subtle reply' }, true));
      if (!thread && !message.replyTo) actions.append(iconButton('查看线程', 'thread', () => {
        state.thread = message; openRoom(); chat.querySelector('h1')?.focus();
      }, { class: 'subtle reply' }, true));
      if(state.session.imRealtime && message.authorId===state.session.user.id) actions.append(button('撤回',async event=>{
        const control=event.currentTarget;
        control.disabled=true;
        try { await post(path+'/'+encodeURIComponent(message.id)+'/retract',{}); await refresh(true,true); }
        catch(error) { info.textContent='未能撤回消息：'+error.message; }
        finally { control.disabled=false; }
      },{class:'subtle'}));
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
        el('p', {}, thread ? '写一条回复，继续当前讨论。' : direct ? '写一条消息开始私聊。' : '写一条消息开始协作。需要对方接手时，再选中 @ 成员。')));
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
    let syncQueued=false;
    let appendQueued=false;
    let renderedCursor=null, renderedCount=0, acknowledged=null, reading=false;
    function acknowledgeRead() {
      const cursor=visibleReadCursor({
        active:modern&&marker===state.epoch&&feed.isConnected,
        focused:document.hasFocus(), visible:document.visibilityState==='visible',
        conversationVisible:state.mobile||!document.defaultView?.matchMedia?.('(max-width: 760px)').matches,
        atBottom:feed.scrollHeight-feed.scrollTop-feed.clientHeight<16,
        thread, cursor:renderedCursor, rendered:renderedCount,
      });
      if(!cursor||reading||cursor===acknowledged) return;
      reading=true;
      post(roomPath+'/read',{cursor}).then(()=>{
        acknowledged=cursor;
        void refreshRooms();
      }).catch(error=>{
        if(marker===state.epoch&&error.status===401) mountLogin('登录已失效，请重新登录。');
      }).finally(()=>{
        reading=false;
        if(acknowledged===cursor&&renderedCursor!==cursor&&marker===state.epoch) acknowledgeRead();
      });
    }
    function markRendered() {
      renderedCursor=state.cursor;
      renderedCount=state.items.length;
      acknowledgeRead();
    }
    async function refresh(explicit = false, fromStart = false) {
      if(marker!==state.epoch) return;
      if(state.pending) {syncQueued ||= fromStart;appendQueued ||= !fromStart&&modern;return;}
      if(!explicit && state.hasMore) return;
      state.pending=true;
      const query = new URLSearchParams({ limit: '60' });
      if (!fromStart && state.cursor != null) query.set('after', state.cursor);
      if (thread) query.set('thread', thread.id);
      try {
        // Phase 1 automatically catches up private conversations. Group and
        // thread history retain their explicit bounded paging behavior.
        if(modern&&direct&&!thread) {
          const batch=await collectRoomPages(cursor=>{
            if(cursor!=null) query.set('after',cursor); else query.delete('after');
            return api(path+'?'+query.toString());
          },fromStart?null:state.cursor,fromStart?[]:state.items,()=>marker===state.epoch);
          if(!batch||marker!==state.epoch) return;
          const changed=renderedCursor===null||JSON.stringify(batch.messages)!==JSON.stringify(state.items);
          state.items=batch.messages;
          state.cursor=batch.nextCursor;
          state.hasMore=false;
          if(changed) paintFeed();
          markRendered();
          if(explicit||info.dataset.error==='refresh'){info.textContent='';delete info.dataset.error;}
          return;
        }
        let data = await api(path + '?' + query.toString());
        if (marker !== state.epoch) return;
        if(fromStart) {
          const limit=state.items.length+60;
          const loaded=[...data.messages];
          while(data.hasMore && loaded.length<limit) {
            query.set('after',data.nextCursor);
            data=await api(path+'?'+query.toString());
            if(marker!==state.epoch) return;
            loaded.push(...data.messages);
          }
          const changed=state.hasMore!==Boolean(data.hasMore)||JSON.stringify(loaded)!==JSON.stringify(state.items);
          state.items=loaded;
          state.cursor=data.nextCursor;
          state.hasMore=Boolean(data.hasMore);
          if(changed) paintFeed();
          markRendered();
          if(info.dataset.error==='refresh') {info.textContent='';delete info.dataset.error;}
          return;
        }
        const first = state.cursor == null;
        const changed = first || data.messages.length > 0 || state.hasMore !== Boolean(data.hasMore);
        state.items = mergeMessages(state.items, data.messages);
        state.cursor = data.nextCursor ?? state.cursor;
        state.hasMore = Boolean(data.hasMore);
        if (changed) paintFeed();
        markRendered();
        if (explicit || info.dataset.error === 'refresh') { info.textContent = ''; delete info.dataset.error; }
      } catch (error) {
        if (marker !== state.epoch) return;
        if (error.status === 401) return mountLogin('登录已失效，请重新登录。');
        info.dataset.error = 'refresh';
        info.textContent = `消息未刷新：${error.message}`;
      } finally {
        if(marker===state.epoch) {
          state.pending=false;
          if(syncQueued||appendQueued){const restart=syncQueued;syncQueued=appendQueued=false;void refresh(true,restart);}
        }
      }
    }
    const mediaStatus=notice('status');
    let recording;
    let stream;
    async function sendMedia(file,kind,attachmentId=requestId()) {
      const current=()=>marker===state.epoch;
      if(!file || !current()) return;
      mediaStatus.textContent='正在发送…';
      try {
        await uploadAttachment(roomPath+'/attachments',file,kind,attachmentId);
        if(current()) mediaStatus.textContent='';
        await refresh(true,true);
      } catch(error) {
        if(current()) mediaStatus.replaceChildren(
          el('span',{},'未确认附件发送：'+error.message),
          button('重试附件',()=>sendMedia(file,kind,attachmentId),{class:'subtle'}));
      }
    }
    function mediaPicker(label,kind,accept) {
      const pick=el('input',{type:'file','aria-label':label,accept,
        onchange:event=>{
          const element=event.currentTarget;
          const file=element.files[0];
          element.value='';
          void sendMedia(file,kind);
        }});
      return el('label',{class:'media-picker'},label,pick);
    }
    const record=button('录制语音',async ()=>{
      if(recording?.state==='recording') {
        recording.stop();
        record.textContent='录制语音';
        return;
      }
      if(!navigator.mediaDevices?.getUserMedia||!globalThis.MediaRecorder?.isTypeSupported('audio/webm')) {
        mediaStatus.textContent='此浏览器或连接不支持语音录制。';
        return;
      }
      record.disabled=true;
      try {
        const acquired=await navigator.mediaDevices.getUserMedia({audio:true});
        if(marker!==state.epoch) {acquired.getTracks().forEach(track=>track.stop());return;}
        stream=acquired;
        const chunks=[];
        const microphone=new MediaRecorder(stream,{mimeType:'audio/webm'});
        recording=microphone;
        const maxDuration=setTimeout(()=>{if(microphone.state==='recording') microphone.stop();},120_000);
        const release=()=>{clearTimeout(maxDuration);acquired.getTracks().forEach(track=>track.stop());};
        microphone.addEventListener('dataavailable',({data})=>{if(data.size) chunks.push(data);});
        microphone.addEventListener('error',()=>{release();if(marker===state.epoch) mediaStatus.textContent='录音未完成。';});
        microphone.addEventListener('stop',()=>{
          release();
          if(marker!==state.epoch) return;
          record.textContent='录制语音';
          const voice=new File(chunks,'语音消息.webm',{type:'audio/webm'});
          if(voice.size) void sendMedia(voice,'voice');
          else mediaStatus.textContent='录音太短，请重试。';
        });
        microphone.start();
        state.stopRecording=()=>{release();if(microphone.state==='recording') microphone.stop();};
        record.textContent='停止并发送语音';
        mediaStatus.textContent='正在录音';
      } catch(error) {
        stream?.getTracks().forEach(track=>track.stop());
        mediaStatus.textContent='无法录音，请检查浏览器麦克风权限。';
      } finally {record.disabled=false;}
    },{class:'subtle'});
    const mediaControls=state.session.imRealtime ? el('div',{class:'media-controls'},
      mediaPicker('发送图片','image','image/png,image/jpeg,image/webp,image/gif'),
      mediaPicker('发送文件','file'),record,mediaStatus) : null;
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
    } }, el('div', { class: 'composer-context' }, reply, selected, choices), mediaControls,
      el('div', { class: 'composer-field' }, input, el('div', { class: 'composer-actions' }, direct?null:toggle, submit)));
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
    const back = iconButton(modern?'返回会话列表':'返回群聊列表', 'arrow', () => { state.mobile = false; chat.dataset.mobile = 'rooms'; rooms.querySelector('[aria-current]')?.focus(); }, { class: 'mobile-back icon-button' });
    const threadBack = thread ? iconButton('返回群聊', 'arrow', () => {
      state.thread = null; openRoom(); chat.querySelector('h1')?.focus();
    }, { class: 'icon-button' }) : null;
    const headingBox = el('div', { class: 'conversation-title' },
      thread ? el('span', { class: 'overline' }, room.name) : null,
      el('div', { class: 'conversation-heading' }, icon(thread ? 'thread' : direct?'chat':'hash'), heading));
    const bar = el('header', { class: 'conversation-bar' },
      el('div', { class: 'conversation-bar-inner' }, back, threadBack, headingBox,
        el('div', { class: 'header-actions' }, direct?null:memberButton, iconButton('刷新', 'refresh', () => refresh(true), { class: 'icon-button' }))));
    const conversation = el('article', { class: 'conversation' }, bar,
      el('div', { class: 'conversation-context' }, info, memberPanel), feed, el('div', { class: 'composer-dock' }, form));
    chat.append(conversation);
    paintMentions(); paintReply();
    refresh(true);
    if(!direct) refreshMembers();
    state.tick = () => refresh();
    state.sync = () => {acknowledgeRead();return refresh(true,true);};
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
function taskArtifacts(task, epoch) {
  const path='/api/tasks/'+encodeURIComponent(task.id)+'/artifacts';
  const list=el('div'), feedback=notice('alert');
  const live=()=>epoch===state.epoch;
  let loading=false, loaded=false, generation=0, retry;
  async function refresh() {
    const attempt=++generation;
    loading=true;
    try {
      const {artifacts}=await api(path);
      if(!live()||attempt!==generation) return;
      list.replaceChildren(listRows(artifacts, artifact=>el('div',{class:'row'},
        el('a',{href:path+'/'+encodeURIComponent(artifact.id),download:''},artifact.name),
        el('span',{class:'muted'},artifact.bytes+' B')), '暂无产物。'));
      loaded=true;
    } catch(error) {
      if(live()&&attempt===generation) list.replaceChildren(el('p',{role:'alert'},error.message),button('重试加载产物',refresh));
    } finally { if(attempt===generation) loading=false; }
  }
  const details=el('details',{ontoggle:event=>{
    if(event.currentTarget.open&&!loaded&&!loading) void refresh();
  }},
    el('summary',{},'任务产物'),list);
  const me=state.session.user;
  if(me.kind==='human'||(me.id===task.assigneeId&&!['accepted','cancelled'].includes(task.status))){
    const name=el('input',{required:'',maxlength:'120',placeholder:'review.txt / report.md'});
    const kind=el('select',{},el('option',{value:'text'},'纯文本 (.txt)'),el('option',{value:'markdown'},'Markdown (.md)'));
    const text=el('textarea',{required:'',maxlength:'24576'});
    const submit=el('button',{type:'submit'},'添加产物');
    const form=el('form',{class:'inline-form',onsubmit:async event=>{
      event.preventDefault();
      if(submit.disabled) return;
      submit.disabled=true;
      feedback.textContent='';
      const payload={name:name.value.trim(),kind:kind.value,text:text.value};
      const signature=JSON.stringify(payload);
      if(retry?.signature!==signature) retry={signature,id:requestId()};
      try {
        await post(path,{...payload,clientRequestId:retry.id});
        if(!live()) return;
        retry=undefined;
        if(JSON.stringify({name:name.value.trim(),kind:kind.value,text:text.value})===signature) form.reset();
        await refresh();
      } catch(error) {
        if(live()) feedback.textContent=error.message;
      } finally { submit.disabled=false; }
    }},field('文件名',name),field('文件类型',kind),field('产物正文',text),submit,feedback);
    details.append(form);
  }
  return details;
}
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
      actions, feedback, taskArtifacts(task,epoch));
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
  if(state.session.imRealtime&&state.session.user.id==='owner') {
    const panel=el('div',{class:'inline-form',hidden:''});
    const invite=button('添加真人成员',()=>{panel.hidden=!panel.hidden;if(!panel.hidden) name.focus();});
    const name=el('input',{required:'',maxlength:'80'});
    const feedback=notice('status');
    const send=el('button',{type:'submit',class:'primary'},'生成成员密钥');
    panel.append(el('form',{onsubmit:async event=>{
      event.preventDefault();
      send.disabled=true;
      try {
        const {token}=await post('/api/humans',{name:name.value});
        name.value='';
        feedback.replaceChildren(el('p',{},'仅在此显示，请通过可信渠道交给成员。'),
          el('code',{'data-testid':'human-invitation',class:'secret'},token),
          button('隐藏成员密钥',()=>feedback.replaceChildren()));
      } catch(error) {feedback.textContent=error.message;}
      finally {send.disabled=false;}
    }},field('真人显示名称',name),send),feedback);
    page.append(invite,panel);
  }
}
globalThis.setInterval(() => {
  if (state.session && !state.session.imRealtime && state.page === 'chat' && document.visibilityState !== 'hidden') state.tick?.();
}, 5000);
function returnToChat() {
  if(state.page==='chat' && document.visibilityState==='visible' && document.hasFocus()) state.reconcile?.();
}
document.addEventListener('visibilitychange',returnToChat);
document.defaultView?.addEventListener('focus',returnToChat);
bootstrap();
