export function createChatPayload({ body, mentions = [], replyTo, taskRef }, clientRequestId) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('请输入消息');
  const value = { clientRequestId, body: body.trim(), mentions: [...new Set(mentions)] };
  if (replyTo) value.replyTo = replyTo;
  if (taskRef) value.taskRef = taskRef;
  return value;
}

export function mergeMessages(previous, next) {
  return [...new Map([...previous, ...next].map(message => [message.id, message])).values()];
}

export function chooseRoom(rooms, preferred) {
  return rooms.find(room => room.id === preferred)?.id ?? rooms[0]?.id ?? null;
}

export async function collectRoomPages(loadPage, cursor, previous, stillActive) {
  const messages = new Map(previous.map(message => [message.id, message]));
  const seen = new Set([cursor]);
  while (stillActive()) {
    const page = await loadPage(cursor);
    if (!stillActive()) return null;
    for (const message of page.messages) messages.set(message.id, message);
    if (!page.hasMore) return {messages:[...messages.values()],nextCursor:page.nextCursor ?? cursor};
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('会话分页未能继续，请重试。');
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  return null;
}

export function visibleReadCursor({ active, focused, visible, conversationVisible, atBottom, thread, cursor, rendered }) {
  return active && focused && visible && conversationVisible && atBottom && !thread &&
    typeof cursor === 'string' && /^[1-9]\d*$/.test(cursor) && rendered > 0 ? cursor : null;
}

export function contactAction(status) {
  if (status === 'none') return {path:'/api/contacts/request',label:'发起好友申请'};
  if (status === 'incoming') return {path:'/api/contacts/accept',label:'接受好友申请'};
  if (status === 'friend') return {path:'/api/direct',label:'发消息'};
  return null;
}
