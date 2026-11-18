import { randomUUID } from 'node:crypto';

const maxBytes=24*1024, maxPerTask=20;
const extensions=new Map([['text','.txt'],['markdown','.md']]);
const metadata='id,task_id,author_id,name,kind,bytes,created_at';
const present=row=>({id:row.id,taskId:row.task_id,authorId:row.author_id,name:row.name,kind:row.kind,bytes:row.bytes,createdAt:row.created_at});

export function openArtifacts(db,{requireMembership,tx,reject}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      author_id TEXT NOT NULL REFERENCES actors(id),
      request_id TEXT NOT NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','markdown')),
      text TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 24576),
      created_at TEXT NOT NULL, UNIQUE(task_id,author_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS artifacts_task_date ON task_artifacts(task_id,created_at,id);
  `);
  const task=db.prepare('SELECT room_id,assignee_id,status FROM tasks WHERE id=?');
  const list=db.prepare('SELECT '+metadata+' FROM task_artifacts WHERE task_id=? ORDER BY created_at,id');
  const find=db.prepare('SELECT '+metadata+',text FROM task_artifacts WHERE task_id=? AND id=?');
  const request=db.prepare('SELECT '+metadata+',text FROM task_artifacts WHERE task_id=? AND author_id=? AND request_id=?');
  const count=db.prepare('SELECT count(*) total FROM task_artifacts WHERE task_id=?');
  const insert=db.prepare('INSERT INTO task_artifacts(id,task_id,author_id,request_id,name,kind,text,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  const scope=(a,taskId)=>{
    const row=task.get(taskId);
    if(!row) reject(404,'Task not found');
    requireMembership(a,row.room_id);
    return row;
  };
  return {
    list(a,taskId) {
      scope(a,taskId);
      return list.all(taskId).map(present);
    },
    get(a,taskId,artifactId) {
      scope(a,taskId);
      const row=find.get(taskId,artifactId);
      if(!row) reject(404,'Artifact not found');
      return {...present(row),text:row.text};
    },
    create(a,taskId,input) {
      return tx(()=>{
        const task=scope(a,taskId);
        if(a.kind!=='human'&&task.assignee_id!==a.id) reject(403,'Artifact publication not authorized');
        if(Object.keys(input).some(key=>!['clientRequestId','name','kind','text'].includes(key))) reject(400,'Unrecognized artifact fields');
        const {clientRequestId,name,kind,text}=input;
        if(typeof clientRequestId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(clientRequestId)) reject(400,'Invalid artifact request ID');
        const extension=extensions.get(kind);
        if(!extension) reject(400,'Unsupported artifact kind');
        if(typeof name!=='string'||name.length>120||!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_. ()-]*$/u.test(name)
          ||!name.endsWith(extension)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) reject(400,'Invalid artifact name');
        if(typeof text!=='string'||!text.trim()||!text.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) reject(400,'Invalid artifact text');
        const bytes=Buffer.byteLength(text);
        if(bytes>maxBytes) reject(413,'Artifact exceeds 24 KiB');
        const prior=request.get(taskId,a.id,clientRequestId);
        if(prior) {
          if(prior.name!==name||prior.kind!==kind||prior.text!==text) reject(409,'Artifact request ID was reused with different content');
          return present(prior);
        }
        if(a.kind!=='human'&&['accepted','cancelled'].includes(task.status)) reject(409,'Task is closed for agent publication');
        if(count.get(taskId).total>=maxPerTask) reject(409,'Task already contains 20 artifacts');
        const id=randomUUID(), createdAt=new Date().toISOString();
        insert.run(id,taskId,a.id,clientRequestId,name,kind,text,bytes,createdAt);
        return {id,taskId,authorId:a.id,name,kind,bytes,createdAt};
      });
    },
  };
}

export function artifactDisposition({name,kind}) {
  const encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="artifact${extensions.get(kind)}"; filename*=UTF-8''${encoded}`;
}
