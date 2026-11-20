import { createHash } from 'node:crypto';

export function openImContacts(db,{get,all,run,tx,reject,requireActor,requireMembership,now,isManaged}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
      lo TEXT NOT NULL REFERENCES actors(id), hi TEXT NOT NULL REFERENCES actors(id),
      requester TEXT NOT NULL REFERENCES actors(id), accepted_at TEXT,
      PRIMARY KEY(lo,hi), CHECK(lo<hi), CHECK(requester=lo OR requester=hi)
    );
    CREATE INDEX IF NOT EXISTS friendships_hi ON friendships(hi,lo);
    CREATE TABLE IF NOT EXISTS direct_rooms (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id), lo TEXT NOT NULL, hi TEXT NOT NULL,
      UNIQUE(lo,hi), FOREIGN KEY(lo,hi) REFERENCES friendships(lo,hi)
    );
    CREATE TRIGGER IF NOT EXISTS direct_room_member_guard BEFORE INSERT ON members
      WHEN EXISTS(SELECT 1 FROM direct_rooms d WHERE d.room_id=NEW.room_id AND NEW.actor_id NOT IN (d.lo,d.hi))
      BEGIN SELECT RAISE(ABORT,'Direct conversation participants are fixed'); END;
    CREATE TABLE IF NOT EXISTS human_room_reads (
      actor_id TEXT NOT NULL REFERENCES actors(id), room_id TEXT NOT NULL REFERENCES rooms(id),
      cursor INTEGER NOT NULL CHECK(cursor>=0), PRIMARY KEY(actor_id,room_id)
    );
  `);
  const fold=value=>value.normalize('NFKC').toLowerCase();
  db.function('agentchat_fold_name',{deterministic:true},fold);
  const getHuman=a=>{
    const actor=requireActor(a);
    if(actor.kind!=='human') reject(403,'Human session required');
    return actor;
  };
  const pair=(a,b)=>a<b?[a,b]:[b,a];
  const relation=(lo,hi)=>get('SELECT requester,accepted_at FROM friendships WHERE lo=? AND hi=?',lo,hi);
  const status=(row,id)=>!row?'none':row.accepted_at?'friend':row.requester===id?'outgoing':'incoming';
  const person=row=>({id:row.id,name:row.name});
  const direct=room=>get('SELECT lo,hi FROM direct_rooms WHERE room_id=?',room);
  const visible=(id,room)=>{
    const row=direct(room);
    return !row||row.lo===id||row.hi===id;
  };
  const other=(a,id)=>{
    if(typeof id!=='string'||!(/^[a-z0-9-]{1,80}$/i.test(id))||id===a.id) reject(404,'Member not found');
    const result=get("SELECT id,name FROM actors WHERE id=? AND kind='human' AND enabled=1",id);
    if(!result) reject(404,'Member not found');
    return result;
  };
  const state=(id,room)=>get(`SELECT
    COALESCE((SELECT cursor FROM human_room_reads WHERE actor_id=? AND room_id=?),0) cursor,
    (SELECT COUNT(*) FROM messages m WHERE m.room_id=? AND m.author_id<>? AND m.retracted_at IS NULL
     AND m.seq>COALESCE((SELECT cursor FROM human_room_reads WHERE actor_id=? AND room_id=?),0)) unread`,id,room,room,id,id,room);
  const roomInfo=(actor,room,peer)=>({
    id:room.id,name:peer?.name??room.name,kind:peer?'direct':'group',...(peer?{peer:person(peer)}:{}),
    ...(!peer&&isManaged(room.id)?{managed:true}:{}), unread:state(actor.id,room.id).unread
  });
  return {
    visible,
    isDirect:room=>Boolean(direct(room)),
    list(a){
      const actor=getHuman(a);
      const result={friends:[],incoming:[],outgoing:[]};
      const rows=all(`SELECT h.id,h.name,f.requester,f.accepted_at FROM friendships f
        JOIN actors h ON h.id=CASE WHEN f.lo=? THEN f.hi ELSE f.lo END
        WHERE (f.lo=? OR f.hi=?) AND h.kind='human' AND h.enabled=1 ORDER BY h.name,h.id`,actor.id,actor.id,actor.id);
      for(const row of rows){
        const type=status(row,actor.id);
        result[type==='friend'?'friends':type].push(person(row));
      }
      return result;
    },
    search(a,query){
      const actor=getHuman(a);
      if(typeof query!=='string'||query.length>80) reject(400,'Enter a name to search');
      const q=fold(query).trim();
      if(!q) return [];
      // Search is bounded and literal; SQLite LIKE's wildcard syntax is not user input.
      const rows=all(`SELECT h.id,h.name,f.requester,f.accepted_at FROM actors h
        LEFT JOIN friendships f ON f.lo=MIN(h.id,?) AND f.hi=MAX(h.id,?)
        WHERE h.kind='human' AND h.enabled=1 AND h.id<>? AND instr(agentchat_fold_name(h.name),?)>0
        ORDER BY h.name,h.id LIMIT 30`,actor.id,actor.id,actor.id,q);
      return rows.map(row=>({...person(row),status:status(row.requester?row:null,actor.id)}));
    },
    request(a,id){
      return tx(()=>{
        const actor=getHuman(a),peer=other(actor,id),[lo,hi]=pair(actor.id,id);
        const {changes}=run('INSERT OR IGNORE INTO friendships (lo,hi,requester) VALUES (?,?,?)',lo,hi,actor.id);
        return {...person(peer),status:status(relation(lo,hi),actor.id),changed:changes>0};
      });
    },
    accept(a,id){
      return tx(()=>{
        const actor=getHuman(a),peer=other(actor,id),[lo,hi]=pair(actor.id,id);
        const current=relation(lo,hi);
        if(!current || (!current.accepted_at&&current.requester===actor.id)) reject(409,'No incoming request');
        if(!current.accepted_at) run('UPDATE friendships SET accepted_at=? WHERE lo=? AND hi=?',now(),lo,hi);
        return {...person(peer),status:'friend',changed:!current.accepted_at};
      });
    },
    openDirect(a,id){
      return tx(()=>{
        const actor=getHuman(a),peer=other(actor,id),[lo,hi]=pair(actor.id,id);
        if(!relation(lo,hi)?.accepted_at) reject(404,'Conversation not available');
        const stored=get('SELECT room_id FROM direct_rooms WHERE lo=? AND hi=?',lo,hi);
        if(stored) return {...roomInfo(actor,{id:stored.room_id},peer),created:false};
        const roomId='dm-'+createHash('sha256').update(JSON.stringify([lo,hi])).digest('hex');
        run('INSERT INTO rooms (id,name) VALUES (?,?)',roomId,'Direct conversation');
        run('INSERT INTO direct_rooms (room_id,lo,hi) VALUES (?,?,?)',roomId,lo,hi);
        run('INSERT INTO members (room_id,actor_id) VALUES (?,?),(?,?)',roomId,lo,roomId,hi);
        return {...roomInfo(actor,{id:roomId},peer),created:true};
      });
    },
    rooms(a){
      const actor=getHuman(a);
      const rows=all(`SELECT r.id,r.name,d.room_id direct_id,h.id peer_id,h.name peer_name FROM rooms r
        JOIN members m ON m.room_id=r.id
        LEFT JOIN direct_rooms d ON d.room_id=r.id
        LEFT JOIN actors h ON h.id=CASE WHEN d.lo=? THEN d.hi ELSE d.lo END
        WHERE m.actor_id=? AND (d.room_id IS NULL OR ? IN (d.lo,d.hi))
        ORDER BY COALESCE(h.name,r.name),r.id`,actor.id,actor.id,actor.id);
      return rows.map(r=>roomInfo(actor,r,r.direct_id?{id:r.peer_id,name:r.peer_name}:null));
    },
    markRead(a,roomId,cursor){
      return tx(()=>{
        const actor=getHuman(a);
        requireMembership(actor,roomId);
        if(typeof cursor!=='string'||!/^\d{1,16}$/.test(cursor)||!Number.isSafeInteger(Number(cursor))) reject(400,'Invalid read cursor');
        const seq=Number(cursor);
        if(seq!==0&&!get('SELECT 1 FROM messages WHERE room_id=? AND seq=?',roomId,seq)) reject(400,'Invalid room cursor');
        const before=state(actor.id,roomId);
        if(seq>before.cursor){
          run(`INSERT INTO human_room_reads (actor_id,room_id,cursor) VALUES (?,?,?)
            ON CONFLICT(actor_id,room_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`,actor.id,roomId,seq);
        }
        const data=seq>before.cursor?state(actor.id,roomId):before;
        return {roomId,cursor:String(data.cursor),unread:data.unread,advanced:seq>before.cursor};
      });
    },
  };
}
