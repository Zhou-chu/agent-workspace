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
