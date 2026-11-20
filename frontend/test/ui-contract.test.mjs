import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRoomPages, contactAction, createChatPayload, mergeMessages, chooseRoom, visibleReadCursor } from '../public/chat-model.mjs';

test('ordinary text and ordinary replies cannot implicitly wake an agent', () => {
  assert.deepEqual(createChatPayload({ body: ' @agent ?', replyTo: 'old' }, 'id'), {
    clientRequestId: 'id', body: '@agent ?', mentions: [], replyTo: 'old',
  });
});
test('only explicitly selected actor IDs become de-duplicated mentions', () => {
  assert.deepEqual(createChatPayload({ body: 'go', mentions: new Set(['a1', 'a2', 'a1']) }, 'id'), {
    clientRequestId: 'id', body: 'go', mentions: ['a1', 'a2'],
  });
  assert.throws(() => createChatPayload({ body: ' ' }, 'id'), /消息/);
});
test('newly read messages are merged idempotently without disturbing order', () => {
  const a = { id: 'a', body: 'once' };
  const b = { id: 'b', body: 'twice' };
  assert.deepEqual(mergeMessages([a], [a, b]), [a, b]);
});
test('stale mobile room IDs fall back to an authorized available room', () => {
  const rooms = [{ id: 'default' }, { id: 'second' }];
  assert.equal(chooseRoom(rooms, 'second'), 'second');
  assert.equal(chooseRoom(rooms, 'forbidden'), 'default');
  assert.equal(chooseRoom([], 'forbidden'), null);
});

test('offline room catch-up advances over all pages and preserves one copy of each message', async () => {
  const overlapping = {id:'second',body:'retained'};
  const pages = new Map([
    [null,{messages:[{id:'first'},overlapping],nextCursor:'2',hasMore:true}],
    ['2',{messages:[overlapping,{id:'third'}],nextCursor:'3',hasMore:true}],
    ['3',{messages:[{id:'fourth'}],nextCursor:'4',hasMore:false}],
  ]);
  const requested=[];
  const result=await collectRoomPages(async cursor=>{requested.push(cursor);return pages.get(cursor);},null,[],()=>true);
  assert.deepEqual(requested,[null,'2','3']);
  assert.deepEqual(result,{messages:[{id:'first'},overlapping,{id:'third'},{id:'fourth'}],nextCursor:'4'});
});

test('room catch-up rejects a stuck cursor and discards a superseded conversation', async () => {
  await assert.rejects(collectRoomPages(async ()=>({messages:[{id:'one'}],nextCursor:'5',hasMore:true}),'5',[],()=>true),/分页/);
  assert.equal(await collectRoomPages(async ()=>({messages:[{id:'one'}],nextCursor:'6',hasMore:false}),'5',[],()=>false),null);
});

test('a read boundary requires actual rendered data in the foreground conversation at the bottom', () => {
  const visible={active:true,focused:true,visible:true,conversationVisible:true,atBottom:true,thread:false,cursor:'9',rendered:3};
  assert.equal(visibleReadCursor(visible),'9');
  for (const key of ['active','focused','visible','conversationVisible','atBottom']) {
    assert.equal(visibleReadCursor({...visible,[key]:false}),null,key);
  }
  assert.equal(visibleReadCursor({...visible,thread:true}),null);
  assert.equal(visibleReadCursor({...visible,rendered:0}),null);
  assert.equal(visibleReadCursor({...visible,cursor:'0'}),null);
});

test('friend request actions never open a DM until explicit confirmation', () => {
  assert.deepEqual(['none','incoming','outgoing','friend','unknown'].map(contactAction),[
    {path:'/api/contacts/request',label:'发起好友申请'},
    {path:'/api/contacts/accept',label:'接受好友申请'},
    null,
    {path:'/api/direct',label:'发消息'},
    null,
  ]);
});
