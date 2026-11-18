import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openHosts } from './hosts.mjs';

export function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}
export const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const id = () => randomUUID();
const actor = row => row && ({ id: row.id, kind: row.kind, name: row.name, ownerId: row.owner_id, enabled: Boolean(row.enabled) });
function str(v, name, max, min = 1) {
  if (typeof v !== 'string' || v.length > max || v.trim().length < min) reject(400, 'Invalid ' + name);
  return v;
}
const optional = (v, name, max = 80) => v == null ? null : str(v, name, max);
const bool = v => typeof v === 'boolean' ? Number(v) : reject(400, 'Invalid enabled state');

export function openWorkspace(path, ownerName = 'Owner', {clock=Date.now}={}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')), name TEXT NOT NULL, owner_id TEXT REFERENCES actors(id), token_hash TEXT UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
      CHECK((kind='human' AND owner_id IS NULL AND token_hash IS NULL) OR (kind='agent' AND owner_id IS NOT NULL AND token_hash IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (room_id TEXT NOT NULL REFERENCES rooms(id), actor_id TEXT NOT NULL REFERENCES actors(id), PRIMARY KEY(room_id,actor_id));
    CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id), author_id TEXT NOT NULL REFERENCES actors(id),
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, reply_to TEXT REFERENCES messages(id), task_ref TEXT, created_at TEXT NOT NULL,
      UNIQUE(author_id, request_id));
    CREATE INDEX IF NOT EXISTS message_room_seq ON messages(room_id,seq);
    CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), target_id TEXT NOT NULL REFERENCES actors(id), state TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(message_id,target_id));
    CREATE INDEX IF NOT EXISTS reminder_target ON reminders(target_id,created_at);
    CREATE TABLE IF NOT EXISTS chat_consumers (actor_id TEXT NOT NULL REFERENCES actors(id), consumer_id TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id), thread TEXT NOT NULL, cursor INTEGER NOT NULL, PRIMARY KEY(actor_id,consumer_id,room_id,thread));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), author_id TEXT NOT NULL REFERENCES actors(id), title TEXT NOT NULL, description TEXT NOT NULL, assignee_id TEXT REFERENCES actors(id), status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY(task_id,dependency_id), CHECK(task_id <> dependency_id));
    CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), author_id TEXT NOT NULL REFERENCES actors(id), task_ref TEXT REFERENCES tasks(id), question TEXT NOT NULL, options TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS human_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    INSERT OR IGNORE INTO rooms VALUES ('general','General');
  `);
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(col=>col.name==='version')) db.exec('ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  const get = (q,...args) => db.prepare(q).get(...args);
  const all = (q,...args) => db.prepare(q).all(...args);
  const run = (q,...args) => db.prepare(q).run(...args);
  run("INSERT OR IGNORE INTO actors(id,kind,name) VALUES ('owner','human',?)", ownerName);
  run("INSERT OR IGNORE INTO members VALUES ('general','owner')");
  const getActor = actorId => actor(get('SELECT * FROM actors WHERE id=?',actorId));
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const v = fn(); db.exec('COMMIT'); return v; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const requireActor = a => {
    if (!a?.id || !getActor(a.id)?.enabled) reject(403, 'Actor is not enabled');
    return getActor(a.id);
  };
  const requireOwner = a => {
    if (requireActor(a).kind !== 'human') reject(403, 'Human owner required');
  };
  const requireMembership = (a,r) => {
    requireActor(a);
    if (!get('SELECT 1 FROM members WHERE room_id=? AND actor_id=?', r, a.id)) reject(404, 'Room not found');
  };
  const msg = r => ({id:r.id, roomId:r.room_id, authorId:r.author_id, authorName:r.author_name, authorKind:r.author_kind, body:r.body,
    mentions:JSON.parse(r.mentions), replyTo:r.reply_to, taskRef:r.task_ref, createdAt:r.created_at});
  const msgSelect = 'SELECT m.*,a.name author_name,a.kind author_kind FROM messages m JOIN actors a ON a.id=m.author_id';
  const getMessage = msgId => get(msgSelect + ' WHERE m.id=?', msgId);
  const task = r => ({id:r.id,roomId:r.room_id,title:r.title,description:r.description,assigneeId:r.assignee_id,status:r.status,createdAt:r.created_at,version:r.version,dependencyIds:all('SELECT dependency_id FROM task_dependencies WHERE task_id=? ORDER BY dependency_id',r.id).map(x=>x.dependency_id)});
  const decision = r => ({id:r.id,roomId:r.room_id,taskRef:r.task_ref,question:r.question,options:JSON.parse(r.options),status:r.status,response:r.response,createdAt:r.created_at});

  return {
    owner: getActor('owner'), hosts:openHosts(db,{clock,requireOwner,tx}), health: () => get('SELECT 1'), close: () => db.close(),
    authenticateAgent(token) {
      return typeof token === 'string' && token.length <= 512 && token.startsWith('aw_agent_')
        ? actor(get("SELECT * FROM actors WHERE kind='agent' AND enabled=1 AND token_hash=?", digest(token))) ?? null : null;
    },
    createHumanSession() {
      const token = randomBytes(32).toString('base64url');
      const expires = Date.now() + 8*60*60*1000;
      tx(() => {
        run('DELETE FROM human_sessions WHERE expires <= ?',Date.now());
        run('INSERT INTO human_sessions VALUES (?,?)',digest(token),expires);
      });
      return token;
    },
    isHumanSession(token) {
      return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) &&
        Boolean(get('SELECT 1 FROM human_sessions WHERE hash=? AND expires>?',digest(token),Date.now()));
    },
    revokeHumanSession(token) {
      if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) run('DELETE FROM human_sessions WHERE hash=?',digest(token));
    },
    listAgents(a) {
      const me = requireActor(a);
      if (me.kind !== 'human') return [];
      return all('SELECT * FROM actors WHERE owner_id=? ORDER BY name,id',me.id).map(actor);
    },
    createAgent(a,input) {
      requireOwner(a);
      const name = str(input.name,'name',80).trim(), agentId = id();
      const token = 'aw_agent_' + randomBytes(32).toString('base64url');
      return tx(() => {
        run("INSERT INTO actors VALUES (?,'agent',?,?,?,1)",agentId,name,a.id,digest(token));
        run("INSERT INTO members VALUES ('general',?)",agentId);
        return {agent:getActor(agentId),token};
      });
    },
    setAgentEnabled(a,agentId,enabled) {
      requireOwner(a);
      return tx(() => {
        if (!run("UPDATE actors SET enabled=? WHERE kind='agent' AND id=? AND owner_id=?",bool(enabled),agentId,a.id).changes) reject(404,'Agent not found');
        if (!enabled) run("UPDATE reminders SET state='cancelled' WHERE target_id=? AND state='pending'",agentId);
        return getActor(agentId);
      });
    },
    listRooms(a) {
      requireActor(a);
      return all('SELECT r.id,r.name FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.actor_id=? ORDER BY r.name',a.id).map(r=>({...r}));
    },
    createRoom(a,input) {
      requireOwner(a);
      const roomId=id(), name=str(input.name,'name',120).trim();
      return tx(() => {
        run('INSERT INTO rooms VALUES (?,?)',roomId,name);
        run('INSERT INTO members VALUES (?,?)',roomId,a.id);
        return {id:roomId,name};
      });
    },
    listRoomMembers(a,roomId) {
      requireMembership(a,roomId);
      return all('SELECT a.* FROM actors a JOIN members m ON m.actor_id=a.id WHERE m.room_id=? ORDER BY a.name,a.id',roomId).map(actor);
    },
    setRoomMember(a,roomId,agentId,member) {
      requireOwner(a);
      bool(member);
      return tx(() => {
        requireMembership(a,roomId);
        const target=getActor(agentId);
        if (target?.kind!=='agent'||target.ownerId!==a.id) reject(404,'Agent not found');
        if (member) {
          if (!target.enabled) reject(409,'Disabled agents cannot join');
          run('INSERT OR IGNORE INTO members VALUES (?,?)',roomId,agentId);
        } else {
          run('DELETE FROM members WHERE room_id=? AND actor_id=?',roomId,agentId);
          run(`UPDATE reminders SET state='cancelled' WHERE target_id=? AND state='pending'
            AND message_id IN (SELECT id FROM messages WHERE room_id=?)`,agentId,roomId);
        }
        return {roomId,agentId,member};
      });
    },
    listMessages(a,roomId,input) {
      requireMembership(a,roomId);
      const thread = optional(input.thread,'thread');
      if (thread) {
        const root = get('SELECT room_id,reply_to FROM messages WHERE id=?',thread);
        if (!root || root.room_id !== roomId || root.reply_to !== null) reject(404, 'Thread not found');
      }
      const cursor = input.after ?? '0';
      const consumer = optional(input.consumer,'consumer');
      if (consumer && a.kind !== 'agent') reject(400,'Consumer is only valid for agents');
      const previous = consumer ? get('SELECT cursor FROM chat_consumers WHERE actor_id=? AND consumer_id=? AND room_id=? AND thread=?',a.id,consumer,roomId,thread??'')?.cursor : null;
      const effective = input.after == null && previous != null ? String(previous) : String(cursor);
      const limit = input.limit == null ? 50 : Number(input.limit);
      if (!/^\d{1,16}$/.test(effective) || !Number.isSafeInteger(Number(effective)) || !Number.isInteger(limit) || limit<1 || limit>100) reject(400,'Invalid pagination');
      const rows = thread
        ? all(msgSelect + ' WHERE m.room_id=? AND m.seq>? AND (m.id=? OR m.reply_to=?) ORDER BY m.seq LIMIT ?',roomId,Number(effective),thread,thread,limit+1)
        : all(msgSelect + ' WHERE m.room_id=? AND m.seq>? ORDER BY m.seq LIMIT ?',roomId,Number(effective),limit+1);
      const page = rows.slice(0,limit);
      const nextCursor = String(page.at(-1)?.seq ?? effective);
      if (consumer && page.length) run(`INSERT INTO chat_consumers VALUES (?,?,?,?,?) ON CONFLICT (actor_id,consumer_id,room_id,thread) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`,a.id,consumer,roomId,thread??'',Number(nextCursor));
      return {messages:page.map(msg),nextCursor,hasMore:rows.length>limit};
    },
    send(a,roomId,input) {
      const clientRequestId = str(input.clientRequestId,'clientRequestId',100), body = str(input.body,'body',20000);
      const replyTo = optional(input.replyTo,'replyTo'), taskRef = optional(input.taskRef,'taskRef');
      const targets = input.mentions ?? [];
      if (!Array.isArray(targets) || targets.length>16) reject(400,'Invalid mentions');
      const mentions = [...new Set(targets.map(v=>str(v,'mention',80)))].sort();
      const fingerprint = digest(JSON.stringify([roomId,body,mentions,replyTo,taskRef]));
      return tx(() => {
        requireMembership(a,roomId);
        const previous = get(msgSelect + ' WHERE author_id=? AND request_id=?',a.id,clientRequestId);
        if (previous) {
          if (previous.request_hash!==fingerprint) reject(409,'Request identifier already used for different input');
          return msg(previous);
        }
        for (const targetId of mentions) {
          const target = getActor(targetId);
          if (!target?.enabled || !get('SELECT 1 FROM members WHERE room_id=? AND actor_id=?',roomId,targetId)) reject(400,'Mention target is not an enabled room member');
        }
        if (replyTo) {
          const root = getMessage(replyTo);
          if (!root || root.room_id!==roomId || root.reply_to!==null) reject(400,'Reply must refer to a root message in this room');
        }
        if (taskRef && !get('SELECT 1 FROM tasks WHERE room_id=? AND id=?', roomId, taskRef)) reject(400,'Task must belong to this room');
        const msgId = id(), stamp = now();
        run('INSERT INTO messages(id,room_id,author_id,request_id,request_hash,body,mentions,reply_to,task_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          msgId,roomId,a.id,clientRequestId,fingerprint,body,JSON.stringify(mentions),replyTo,taskRef,stamp);
        for (const target of mentions) {
          // An agent message is visible, but its execution may not wake a peer
          // until a connector can provide a trusted causal-chain budget.
          const kind = getActor(target).kind;
          const state = kind === 'human' ? 'notification' : a.kind === 'human' ? 'pending' : 'blocked_no_execution_context';
          run('INSERT INTO reminders VALUES (?,?,?,?,?)',id(),msgId,target,state,stamp);
        }
        return msg(getMessage(msgId));
      });
    },
    listReminders(a) {
      requireActor(a);
      return all('SELECT r.* FROM reminders r JOIN messages m ON m.id=r.message_id JOIN members mem ON mem.room_id=m.room_id AND mem.actor_id=r.target_id WHERE r.target_id=? ORDER BY r.created_at,r.rowid LIMIT 100',a.id).map(r=>({
        id:r.id, message:msg(getMessage(r.message_id)), status:r.state, createdAt:r.created_at,
      }));
    },
    listTasks(a) {
      requireActor(a);
      return all('SELECT t.* FROM tasks t JOIN members m ON m.room_id=t.room_id WHERE m.actor_id=? ORDER BY t.created_at DESC,t.rowid DESC LIMIT 100',a.id).map(task);
    },
    createTask(a,input) {
      requireOwner(a);
      const roomId = str(input.roomId,'roomId',80), title = str(input.title,'title',160), description = str(input.description??'','description',5000,0);
      const assignee = optional(input.assigneeId,'assigneeId');
      const requested = input.dependencyIds??[];
      if (!Array.isArray(requested)||requested.length>16) reject(400,'Invalid dependency list');
      const dependencies = [...new Set(requested.map(x=>str(x,'dependencyId',80)))];
      return tx(() => {
        requireMembership(a,roomId);
        if (assignee && (!getActor(assignee)?.enabled || !get('SELECT 1 FROM members WHERE room_id=? AND actor_id=?',roomId,assignee))) reject(400,'Assignee is not an enabled room member');
        const taskId=id();
        for (const dependency of dependencies)
          if (!get('SELECT 1 FROM tasks WHERE id=? AND room_id=?',dependency,roomId)) reject(400,'Dependency must belong to this room');
        run('INSERT INTO tasks(id,room_id,author_id,title,description,assignee_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
          taskId,roomId,a.id,title,description,assignee,'open',now());
        for (const dependency of dependencies) run('INSERT INTO task_dependencies VALUES (?,?)',taskId,dependency);
        return task(get('SELECT * FROM tasks WHERE id=?',taskId));
      });
    },
    updateTask(a,taskId,input) {
      const me=requireActor(a);
      const expectedVersion=input.expectedVersion, status=str(input.status,'status',30);
      if (!Number.isSafeInteger(expectedVersion)||expectedVersion<1) reject(400,'Expected task version required');
      return tx(() => {
        const row=get('SELECT * FROM tasks WHERE id=?',taskId);
        if (!row) reject(404,'Task not found');
        requireMembership(a,row.room_id);
        if (me.kind!=='human'&&(me.id!==row.assignee_id||['accepted','cancelled'].includes(status))) reject(403,'Task transition not authorized');
        if (row.version!==expectedVersion) reject(409,'Task version changed');
        if (status===row.status) return task(row);
        const next = {open:['in_progress','blocked','cancelled'],in_progress:['blocked','review_requested','cancelled'],
          blocked:['in_progress','cancelled'],review_requested:['accepted','in_progress','cancelled']};
        if (!next[row.status]?.includes(status)) reject(409,'Invalid task state transition');
        if (['in_progress','review_requested'].includes(status) && get(`SELECT 1 FROM task_dependencies d
          JOIN tasks pre ON pre.id=d.dependency_id WHERE d.task_id=? AND pre.status<>'accepted'`,taskId))
          reject(409,'A dependency is not yet accepted');
        run('UPDATE tasks SET status=?,version=version+1 WHERE id=? AND version=?',status,taskId,expectedVersion);
        return task(get('SELECT * FROM tasks WHERE id=?',taskId));
      });
    },
    listDecisions(a) {
      requireActor(a);
      return all('SELECT d.* FROM decisions d JOIN members m ON m.room_id=d.room_id WHERE m.actor_id=? AND (? = ? OR d.author_id=?) ORDER BY d.created_at DESC,d.rowid DESC LIMIT 100',a.id,a.kind,'human',a.id).map(decision);
    },
    createDecision(a,input) {
      const roomId = str(input.roomId,'roomId',80), question = str(input.question,'question',2000), taskRef = optional(input.taskRef,'taskRef');
      if (!Array.isArray(input.options) || input.options.length<2 || input.options.length>12) reject(400,'Provide 2 to 12 distinct options');
      const options = input.options.map(x=>str(x,'option',120).trim());
      if (new Set(options).size!==options.length) reject(400,'Options must be distinct');
      return tx(() => {
        requireMembership(a,roomId);
        if (taskRef && !get('SELECT 1 FROM tasks WHERE room_id=? AND id=? AND (? = ? OR assignee_id=?)', roomId, taskRef,a.kind,'human',a.id)) reject(400,'Task must be authorized in this room');
        const decisionId = id();
        run('INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?)',decisionId,roomId,a.id,taskRef,question,JSON.stringify(options),'pending',null,now());
        return decision(get('SELECT * FROM decisions WHERE id=?',decisionId));
      });
    },
    resolveDecision(a,decisionId,input) {
      requireOwner(a);
      const response = str(input.response,'response',120);
      return tx(() => {
        const row = get('SELECT * FROM decisions WHERE id=?',decisionId);
        if (!row) reject(404,'Decision not found');
        requireMembership(a,row.room_id);
        if (row.response===response) return decision(row);
        if (row.status!=='pending') reject(409,'Decision is already resolved');
        if (!JSON.parse(row.options).includes(response)) reject(400,'Response must be one of the offered options');
        run("UPDATE decisions SET response=?,status='resolved' WHERE id=?",response,decisionId);
        return decision(get('SELECT * FROM decisions WHERE id=?',decisionId));
      });
    },
  };
}
