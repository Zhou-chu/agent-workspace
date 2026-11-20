import { randomUUID } from 'node:crypto';

const idPattern=/^[a-z0-9-]{1,80}$/i;
const isManager=role=>role==='owner'||role==='admin';
const inviteView=r=>({id:r.id,roomId:r.room_id,roomName:r.room_name,inviterId:r.inviter_id,
  inviterName:r.inviter_name,userId:r.invitee_id,userName:r.invitee_name,status:r.status});
const announcementView=r=>({id:r.id,authorId:r.author_id,text:r.text,createdAt:r.created_at});
const inviteSelect=`SELECT i.*, r.name room_name, src.name inviter_name, dst.name invitee_name
  FROM group_invites i JOIN rooms r ON r.id=i.room_id
  JOIN actors src ON src.id=i.inviter_id JOIN actors dst ON dst.id=i.invitee_id`;

export function openImGroups(db,{get,all,run,tx,reject,requireActor,now}){
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_groups (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id), owner_id TEXT NOT NULL,
      FOREIGN KEY(room_id,owner_id) REFERENCES managed_group_members(room_id,actor_id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS managed_group_members (
      room_id TEXT NOT NULL REFERENCES managed_groups(room_id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1)),
      PRIMARY KEY(room_id,actor_id)
    );
    CREATE TRIGGER IF NOT EXISTS managed_humans_only BEFORE INSERT ON managed_group_members
      WHEN NOT EXISTS (SELECT 1 FROM actors WHERE id=NEW.actor_id AND kind='human' AND enabled=1)
      BEGIN SELECT RAISE(ABORT,'Managed group requires an enabled human'); END;
    CREATE TRIGGER IF NOT EXISTS managed_mirror_insert AFTER INSERT ON managed_group_members
      BEGIN INSERT INTO members VALUES (NEW.room_id,NEW.actor_id); END;
    CREATE TRIGGER IF NOT EXISTS managed_mirror_delete AFTER DELETE ON managed_group_members
      BEGIN DELETE FROM members WHERE room_id=OLD.room_id AND actor_id=OLD.actor_id; END;
    CREATE TRIGGER IF NOT EXISTS managed_guard_insert BEFORE INSERT ON members
      WHEN EXISTS (SELECT 1 FROM managed_groups WHERE room_id=NEW.room_id)
      AND NOT EXISTS (SELECT 1 FROM managed_group_members WHERE room_id=NEW.room_id AND actor_id=NEW.actor_id)
      BEGIN SELECT RAISE(ABORT,'Managed membership requires admission'); END;
    CREATE TRIGGER IF NOT EXISTS managed_guard_delete BEFORE DELETE ON members
      WHEN EXISTS (SELECT 1 FROM managed_group_members WHERE room_id=OLD.room_id AND actor_id=OLD.actor_id)
      BEGIN SELECT RAISE(ABORT,'Use managed membership operations'); END;
    CREATE TRIGGER IF NOT EXISTS managed_guard_update BEFORE UPDATE ON members
      WHEN EXISTS (SELECT 1 FROM managed_groups WHERE room_id IN (NEW.room_id,OLD.room_id))
      BEGIN SELECT RAISE(ABORT,'Use managed membership operations'); END;
    CREATE TABLE IF NOT EXISTS group_invites (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES managed_groups(room_id),
      inviter_id TEXT NOT NULL REFERENCES actors(id), invitee_id TEXT NOT NULL REFERENCES actors(id),
      status TEXT NOT NULL CHECK(status IN ('pending_review','pending_acceptance','rejected','accepted','declined')),
      presented INTEGER NOT NULL CHECK(presented IN (0,1)), CHECK(inviter_id<>invitee_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_group_invitee ON group_invites(room_id,invitee_id)
      WHERE status IN ('pending_review','pending_acceptance');
    CREATE INDEX IF NOT EXISTS group_invites_inbox ON group_invites(invitee_id);
    CREATE INDEX IF NOT EXISTS group_invites_outbox ON group_invites(inviter_id);
    CREATE TABLE IF NOT EXISTS group_announcements (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES managed_groups(room_id),
      author_id TEXT NOT NULL REFERENCES actors(id), text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS group_announcements_room ON group_announcements(room_id);
  `);
  const managed=roomId=>Boolean(get('SELECT 1 FROM managed_groups WHERE room_id=?',roomId));
  const human=a=>{
    const actor=requireActor(a);
    if(actor.kind!=='human') reject(403,'Human session required');
    return actor.id;
  };
  const role=(actorId,roomId)=>get(`SELECT CASE WHEN g.owner_id=m.actor_id THEN 'owner'
       WHEN m.admin=1 THEN 'admin' ELSE 'member' END role
    FROM managed_group_members m JOIN managed_groups g USING(room_id)
    WHERE m.room_id=? AND m.actor_id=?`,roomId,actorId)?.role;
  function memberRole(actorId,roomId){
    const current=role(actorId,roomId);
    if(!current) reject(404,'Group not found');
    return current;
  }
  function manager(actorId,roomId){
    if(!isManager(memberRole(actorId,roomId))) reject(403,'Group owner or admin required');
  }
  function field(value,length,label){
    if(typeof value!=='string'||value.length>length||!value.trim()) reject(400,'Invalid '+label);
    return value.trim();
  }
  function byId(roomId,inviteId){
    return get(inviteSelect+' WHERE i.room_id=? AND i.id=?',roomId,inviteId);
  }
  function withdraw(roomId,userId){
    const pending=all(inviteSelect+" WHERE i.room_id=? AND i.inviter_id=? AND i.status IN ('pending_review','pending_acceptance')",roomId,userId);
    run("UPDATE group_invites SET status='rejected' WHERE room_id=? AND inviter_id=? AND status IN ('pending_review','pending_acceptance')",roomId,userId);
    run('DELETE FROM managed_group_members WHERE room_id=? AND actor_id=?',roomId,userId);
    run('DELETE FROM human_room_reads WHERE room_id=? AND actor_id=?',roomId,userId);
    return {roomId,userId,withdrawn:pending.map(r=>({...inviteView(r),presented:Boolean(r.presented)}))};
  }
  function invite(a,roomId,userId){
    return tx(()=>{
      const inviter=human(a), current=memberRole(inviter,roomId);
      if(typeof userId!=='string'||!idPattern.test(userId)||userId===inviter||
         !get(`SELECT 1 FROM friendships f JOIN actors a ON a.id=?
          WHERE f.lo=MIN(?,?) AND f.hi=MAX(?,?) AND f.accepted_at IS NOT NULL AND a.kind='human' AND a.enabled=1`,
          userId,inviter,userId,inviter,userId)) reject(404,'Friend not found');
      if(role(userId,roomId)) reject(409,'Already a group member');
      const existing=get(inviteSelect+" WHERE i.room_id=? AND i.invitee_id=? AND i.status IN ('pending_review','pending_acceptance')",roomId,userId);
      if(existing){
        if(existing.inviter_id!==inviter) reject(409,'Invitation already pending');
        return {invite:inviteView(existing),changed:false,presented:Boolean(existing.presented)};
      }
      const id=randomUUID(), presented=isManager(current);
      run('INSERT INTO group_invites VALUES (?,?,?,?,?,?)',id,roomId,inviter,userId,presented?'pending_acceptance':'pending_review',Number(presented));
      return {invite:inviteView(byId(roomId,id)),changed:true,presented};
    });
  }
  function decide(a,roomId,inviteId,action){
    return tx(()=>{
      const actorId=human(a), reviewing=action==='approve'||action==='reject';
      const steps={approve:['pending_review','pending_acceptance'],reject:['pending_review','rejected'],
        accept:['pending_acceptance','accepted'],decline:['pending_acceptance','declined']};
      if(typeof action!=='string'||!Object.hasOwn(steps,action)) reject(400,'Invalid invitation action');
      if(reviewing) manager(actorId,roomId);
      const row=byId(roomId,inviteId);
      if(!row||(!reviewing&&(row.invitee_id!==actorId||!row.presented))) reject(404,'Invitation not found');
      const [from,to]=steps[action];
      if(row.status===to) return {invite:inviteView(row),changed:false,presented:Boolean(row.presented)};
      if(row.status!==from) reject(409,'Invitation no longer permits this action');
      if(action==='accept') run('INSERT INTO managed_group_members (room_id,actor_id) VALUES (?,?)',roomId,actorId);
      const presented=Boolean(row.presented)||action==='approve';
      run('UPDATE group_invites SET status=?,presented=? WHERE id=?',to,Number(presented),inviteId);
      return {invite:inviteView(byId(roomId,inviteId)),changed:true,presented};
    });
  }
  function member(a,roomId,userId,action){
    return tx(()=>{
      const actorId=human(a), mine=memberRole(actorId,roomId);
      if(!['promote','demote','transfer','remove'].includes(action)) reject(400,'Invalid membership action');
      if(!isManager(mine)||(action!=='remove'&&mine!=='owner')) reject(403,'Group role does not allow this action');
      const theirs=role(userId,roomId);
      if(!theirs) reject(404,'Group member not found');
      if(theirs==='owner'||actorId===userId||(mine==='admin'&&theirs!=='member')) reject(403,'Group role does not allow this action');
      if(action==='remove') return withdraw(roomId,userId);
      if(action==='transfer') run('UPDATE managed_groups SET owner_id=? WHERE room_id=?',userId,roomId);
      run('UPDATE managed_group_members SET admin=? WHERE room_id=? AND actor_id=?',Number(action==='promote'),roomId,userId);
      return {roomId,userId,withdrawn:[]};
    });
  }
  return {
    managed,
    canManage:(a,roomId)=>a.kind==='human'&&isManager(role(a.id,roomId)),
    create(a,input){
      return tx(()=>{
        const actorId=human(a),name=field(input.name,120,'group name'),id=randomUUID();
        run('INSERT INTO rooms VALUES (?,?)',id,name);
        run('INSERT INTO managed_groups VALUES (?,?)',id,actorId);
        run('INSERT INTO managed_group_members (room_id,actor_id) VALUES (?,?)',id,actorId);
        return {id,name,kind:'group',managed:true,unread:0};
      });
    },
    detail(a,roomId){
      const actorId=human(a), current=memberRole(actorId,roomId);
      const {name}=get('SELECT name FROM rooms WHERE id=?',roomId);
      const {unread}=get(`SELECT COUNT(*) unread FROM messages
        WHERE room_id=? AND author_id<>? AND retracted_at IS NULL AND seq>COALESCE(
          (SELECT cursor FROM human_room_reads WHERE room_id=? AND actor_id=?),0)`,roomId,actorId,roomId,actorId);
      const members=all(`SELECT a.id, a.name displayName, CASE WHEN g.owner_id=a.id THEN 'owner'
         WHEN m.admin=1 THEN 'admin' ELSE 'member' END role
        FROM managed_group_members m JOIN managed_groups g USING(room_id)
        JOIN actors a ON a.id=m.actor_id WHERE m.room_id=? ORDER BY a.name,a.id`,roomId).map(r=>({...r}));
      return {room:{id:roomId,name,kind:'group',managed:true,unread},role:current,members};
    },
    invite,decide,member,
    personalInvites(a){
      const actorId=human(a);
      return all(inviteSelect+` WHERE i.inviter_id=? OR (i.invitee_id=? AND i.presented=1)
        ORDER BY (i.status IN ('pending_review','pending_acceptance')) DESC, i.rowid DESC LIMIT 100`,actorId,actorId).map(inviteView);
    },
    groupInvites(a,roomId){
      manager(human(a),roomId);
      return all(inviteSelect+` WHERE i.room_id=?
        ORDER BY (i.status='pending_review') DESC, i.rowid DESC LIMIT 100`,roomId).map(inviteView);
    },
    leave(a,roomId){
      return tx(()=>{
        const actorId=human(a);
        if(memberRole(actorId,roomId)==='owner') reject(409,'Transfer ownership before leaving');
        return withdraw(roomId,actorId);
      });
    },
    announcements(a,roomId){
      memberRole(human(a),roomId);
      return all('SELECT * FROM group_announcements WHERE room_id=? ORDER BY rowid DESC LIMIT 100',roomId).map(announcementView);
    },
    announce(a,roomId,input){
      return tx(()=>{
        const authorId=human(a);
        manager(authorId,roomId);
        const text=field(input.text,2000,'announcement'),id=randomUUID(),createdAt=now();
        run('INSERT INTO group_announcements VALUES (?,?,?,?,?)',id,roomId,authorId,text,createdAt);
        return {id,authorId,text,createdAt};
      });
    }
  };
}
