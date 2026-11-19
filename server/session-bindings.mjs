import { randomUUID } from 'node:crypto';

const readyTaskStatuses=new Set(['open','in_progress','blocked','review_requested']);
const harnesses=new Set(['codex','claude-code','deepseek']);

export function openSessionBindings(db,{requireOwner,requireMembership,reject,tx}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_bindings (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES actors(id),
      room_id TEXT NOT NULL REFERENCES rooms(id), agent_id TEXT NOT NULL REFERENCES actors(id),
      task_id TEXT REFERENCES tasks(id), host_id TEXT NOT NULL REFERENCES workspace_hosts(id),
      harness TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      UNIQUE(host_id,harness,session_id,generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_bindings_room_scope
      ON session_bindings(room_id,agent_id) WHERE active=1 AND task_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS session_bindings_task_scope
      ON session_bindings(task_id,agent_id) WHERE active=1 AND task_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS session_bindings_native_scope
      ON session_bindings(host_id,harness,session_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS session_route_receipts (
      reminder_id TEXT PRIMARY KEY REFERENCES reminders(id),
      binding_id TEXT REFERENCES session_bindings(id)
    );
  `);
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const safeId=(v,label,max=80)=>{
    if (typeof v!=='string'||v.length<1||v.length>max||!/^[A-Za-z0-9_.:-]+$/.test(v)) reject(400,'Invalid '+label);
    return v;
  };
  const scope=(input,allowed)=>{
    if (!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))
      reject(400,'Unrecognized session binding fields');
    const {roomId,agentId,taskId,expectedBindingId}=input;
    if (expectedBindingId!==null) safeId(expectedBindingId,'expected binding ID');
    return [safeId(roomId,'room ID'),safeId(agentId,'agent ID'),taskId==null?null:safeId(taskId,'task ID')];
  };
  const current=(room,agent,task)=>get(`SELECT * FROM session_bindings
    WHERE room_id=? AND agent_id=? AND task_id IS ? AND active=1`,room,agent,task);
  const taskApplies=(room,task,agent)=>{
    const row=get('SELECT status FROM tasks WHERE id=? AND room_id=? AND assignee_id=?',task,room,agent);
    return row && readyTaskStatuses.has(row.status);
  };
  const retireId=id=>run('UPDATE session_bindings SET active=0 WHERE id=?',id);
  const checkPrior=(prior,expected)=>{
    if ((prior?.id??null)!==expected) reject(409,'Session binding changed');
  };
  const fields=['roomId','agentId','taskId','expectedBindingId'];

  return {
    owner: {
      set(a,input) {
        requireOwner(a);
        const [room,agent,task]=scope(input,[...fields,'hostId','harness','sessionId','generation']);
        const host=safeId(input.hostId,'host ID'), session=safeId(input.sessionId,'native session ID',160);
        const {harness,generation,expectedBindingId}=input;
        if (!harnesses.has(harness)||!Number.isSafeInteger(generation)||generation<1)
          reject(400,'Invalid native session identity');
        return tx(()=>{
          requireMembership(a,room);
          if (!get(`SELECT 1 FROM actors a JOIN members m ON m.actor_id=a.id
            WHERE a.id=? AND a.kind='agent' AND a.enabled=1 AND a.owner_id=? AND m.room_id=?`,agent,a.id,room))
            reject(404,'Owned room agent not found');
          if (task && !taskApplies(room,task,agent)) reject(400,'Task must be active and assigned to this room agent');
          if (!get('SELECT 1 FROM workspace_hosts WHERE id=? AND owner_id=? AND revoked=0',host,a.id))
            reject(404,'Enrolled host not found');
          const prior=current(room,agent,task);
          checkPrior(prior,expectedBindingId);
          const latest=get(`SELECT id,room_id,agent_id,generation,active FROM session_bindings
            WHERE host_id=? AND harness=? AND session_id=? ORDER BY generation DESC LIMIT 1`,host,harness,session);
          if (latest && (latest.room_id!==room || latest.agent_id!==agent))
            reject(409,'A native session cannot cross room or agent boundaries');
          if (latest && (generation<=latest.generation || (latest.active && latest.id!==prior?.id)))
            reject(409,'Native session generation or active scope conflicts');
          if (prior) retireId(prior.id);
          const id=randomUUID();
          run(`INSERT INTO session_bindings (id,owner_id,room_id,agent_id,task_id,host_id,harness,session_id,generation)
            VALUES (?,?,?,?,?,?,?,?,?)`,id,a.id,room,agent,task,host,harness,session,generation);
          return {id,generation};
        });
      },
      retire(a,input) {
        requireOwner(a);
        const [room,agent,task]=scope(input,fields);
        return tx(()=>{
          requireMembership(a,room);
          const prior=current(room,agent,task);
          checkPrior(prior,input.expectedBindingId);
          if (!prior || prior.owner_id!==a.id) reject(404,'Session binding not found');
          retireId(prior.id);
          return {id:prior.id,status:'retired'};
        });
      },
      route(a,room,message,target) {
        requireOwner(a);
        requireMembership(a,room);
        const r=get(`SELECT sr.binding_id,b.generation FROM session_route_receipts sr
          JOIN reminders r ON r.id=sr.reminder_id JOIN messages m ON m.id=r.message_id
          LEFT JOIN session_bindings b ON b.id=sr.binding_id
          WHERE m.room_id=? AND m.author_id=? AND m.id=? AND r.target_id=?`,room,a.id,message,target);
        if (!r) return null;
        const status=r.binding_id===null?'blocked_no_binding':'selected_not_dispatched';
        return {status,bindingId:r.binding_id,generation:r.generation};
      },
    },
    // Internal hooks run inside the calling workspace's existing transaction.
    freeze(reminder,owner,room,agent,task) {
      const binding=(!task||taskApplies(room,task,agent)) && get(`SELECT b.id FROM session_bindings b
        JOIN workspace_hosts h ON h.id=b.host_id AND h.owner_id=b.owner_id AND h.revoked=0
        WHERE b.room_id=? AND b.agent_id=? AND b.task_id IS ? AND b.owner_id=? AND b.active=1`,room,agent,task,owner);
      run('INSERT INTO session_route_receipts (reminder_id,binding_id) VALUES (?,?)',reminder,binding?.id??null);
    },
    retireAgent(agent) {
      run('UPDATE session_bindings SET active=0 WHERE agent_id=? AND active=1',agent);
    },
    retireMember(room,agent) {
      run('UPDATE session_bindings SET active=0 WHERE room_id=? AND agent_id=? AND active=1',room,agent);
    },
  };
}
