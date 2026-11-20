import { createServer } from 'node:http';
import { readFile, realpath, stat, mkdir } from 'node:fs/promises';
import { extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { digest, openWorkspace, reject } from './workspace.mjs';
import { artifactDisposition } from './artifacts.mjs';
import { attachmentService, localImStorage, mediaDisposition } from './im-attachments.mjs';

const cookieName = 'workspace_session';
const cookie = req => (req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
const bearer = req => /^Bearer ([A-Za-z0-9_.~+\/-]{1,512})$/i.exec(req.headers.authorization??'')?.[1];
const mime = { '.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2' };
const webDefault = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const maxBody = 96*1024;
const matches = (candidate, expected) => typeof candidate==='string' && candidate.length<=512 &&
  timingSafeEqual(Buffer.from(digest(candidate),'hex'),expected);
function body(req) {
  if ((req.headers['content-type']??'').split(';',1)[0].trim().toLowerCase() !== 'application/json') reject(415,'JSON content type required');
  if (Number(req.headers['content-length'])>maxBody) reject(413,'Request body is too large');
  return new Promise((resolveBody,rejectBody) => {
    let len=0, done=false; const chunks=[];
    req.on('data',chunk=>{
      if (done) return;
      len+=chunk.length;
      if (len>maxBody) {
        done=true;
        rejectBody(Object.assign(new Error('Request body is too large'),{status:413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',()=>{
      if (done) return;
      try {
        const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value===null || Array.isArray(value) || typeof value!=='object') reject(400,'JSON object required');
        resolveBody(value);
      } catch (e) {
        rejectBody(Object.assign(new Error('Invalid JSON object'),{status:400,cause:e}));
      }
    });
    req.on('error',rejectBody);
  });
}
const within = (root, target) => {
  const path = relative(root,target);
  return path !== '..' && !path.startsWith('..'+sep) && !isAbsolute(path);
};
function cookieValue(token, secure, clear=false) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:28800}${secure?'; Secure':''}`;
}
function validateOwnerToken(token) {
  if (typeof token!=='string' || token.length<32 || token.length>512 || !/^[A-Za-z0-9_.~+\/-]+$/.test(token))
    throw new Error('WORKSPACE_TOKEN must be a strong 32–512 character non-space token');
}
export function createWorkspaceServer({ store, ownerToken, webDir=webDefault, secureCookies=false, publicOrigin=null, extension=null, imObjects=null, createRealtime=null }) {
  validateOwnerToken(ownerToken);
  const expected = Buffer.from(digest(ownerToken),'hex');
  if (publicOrigin!==null) {
    const parsed=new URL(publicOrigin);
    if (publicOrigin!==parsed.origin || !['http:','https:'].includes(parsed.protocol)) throw new Error('WORKSPACE_PUBLIC_ORIGIN requires a complete HTTP(S) origin without path');
  }
  const modern = imObjects!==null;
  if(modern && typeof createRealtime!=='function') throw new Error('Realtime transport required for the IM API');
  const attachments = modern ? attachmentService({store,objects:imObjects}) : null;
  let realtime;
  const attempts = new Map();
  const publicSecurity = {
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY',
    'Permissions-Policy':'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Cache-Control':'no-store',
  };
  const json = (res, status, payload, headers={}) => {
    res.writeHead(status, {...publicSecurity,'Content-Type':'application/json; charset=utf-8',...headers});
    res.end(JSON.stringify(payload));
  };
  const auth = req => {
    const token = bearer(req);
    if (req.headers.authorization!==undefined)
      return token ? matches(token,expected) ? store.owner : store.authenticateAgent(token) : null;
    return store.authenticateHumanSession(cookie(req));
  };
  const trustedOrigin = req => publicOrigin??((req.socket.encrypted?'https://':'http://')+req.headers.host);
  const sameOrigin = req => {
    const origin=req.headers.origin;
    if (req.headers['sec-fetch-site']==='cross-site' || (origin&&origin!==trustedOrigin(req)))
      reject(403,'Cross-origin request rejected');
  };
  const server = createServer(async (req,res) => {
    const method = req.method??'GET';
    try {
      if (req.headers.host==null || !(req.url??'').startsWith('/') || (req.url??'').startsWith('//')) reject(400,'Invalid HTTP request');
      const url=new URL(req.url,'http://localhost');
      const path=url.pathname;
      if (method==='GET' && path==='/healthz') {
        store.health();
        return json(res,200,{status:'ok'});
      }
      if (path.startsWith('/api/')) {
        if (method!=='GET' && method!=='HEAD') sameOrigin(req);
        if (method==='POST' && path==='/api/login') {
          const input=await body(req);
          const stamp=Date.now(), key=req.socket.remoteAddress??'unknown';
          let row=attempts.get(key);
          if (row && stamp-row.start>=300000) { attempts.delete(key); row=undefined; }
          if (row?.count>=12) reject(429,'Too many login attempts; wait five minutes');
          const human=matches(input.token,expected) ? store.owner : modern ? store.authenticateHuman(input.token) : null;
          if (!human) {
            if (attempts.size>=4096) for (const [k,v] of attempts) if (stamp-v.start>=300000) attempts.delete(k);
            if (attempts.size>=4096 && !attempts.has(key)) reject(429,'Too many login attempts');
            attempts.set(key,{start:row?.start??stamp,count:(row?.count??0)+1});
            reject(401,'Invalid workspace token');
          }
          attempts.delete(key);
          const token=store.createHumanSession(human.id);
          return json(res,200,{user:human,agents:store.listAgents(human)},{'Set-Cookie':cookieValue(token,secureCookies)});
        }
        if (path.startsWith('/api/host/')) {
          const host=store.hosts.authenticate(bearer(req));
          if (!host) reject(401,'Host authentication required');
          if (method==='POST' && path==='/api/host/heartbeat') return json(res,200,{host:store.hosts.heartbeat(host,await body(req))});
          if (method==='POST' && path==='/api/host/status-checks/claim') return json(res,200,{check:store.hosts.claim(host,await body(req))});
          const ack=/^\/api\/host\/status-checks\/([0-9a-z-]{1,80})\/ack$/i.exec(path);
          if (method==='POST' && ack) return json(res,200,{check:store.hosts.ack(host,ack[1],await body(req))});
          reject(404,'Host route not found');
        }
        // Extension is reserved for an authenticated, typed connector, not for
        // executable input from the same HTTP transport.
        if (extension && await extension({ req,res,method,path,url,json,body,store,actor:auth(req) })) return;
        const actor=auth(req);
        if (!actor) reject(401,'Authentication required');
        if(modern&&(path==='/api/direct'||path==='/api/contacts'||path.startsWith('/api/contacts/'))){
          if(actor.kind!=='human'||req.headers.authorization!==undefined) reject(403,'Human session required');
          if(method==='GET'&&path==='/api/contacts') return json(res,200,store.contacts.list(actor));
          if(method==='GET'&&path==='/api/contacts/search') return json(res,200,{people:store.contacts.search(actor,url.searchParams.get('q'))});
          if(method==='POST'&&(path==='/api/contacts/request'||path==='/api/contacts/accept'||path==='/api/direct')){
            const input=await body(req);
            if(path==='/api/direct'){
              const {created,...room}=store.contacts.openDirect(actor,input.humanId);
              if(created) realtime.notifyRoom(room.id);
              return json(res,200,{room});
            }
            const {changed,...person}=path.endsWith('/request')?store.contacts.request(actor,input.humanId):store.contacts.accept(actor,input.humanId);
            if(changed) realtime.notifyContacts?.(actor.id,person.id);
            return json(res,200,{person});
          }
          reject(404,'Route not found');
        }
        const bindingPath='/api/operator/session-bindings/';
        if (modern && actor.kind==='human' && actor.id!=='owner' &&
            !['/api/logout','/api/session','/api/rooms'].includes(path) && !path.startsWith('/api/rooms/')) reject(403,'Human owner required');
        if (method==='POST' && path.startsWith(bindingPath)) {
          if (actor.kind!=='human'||actor.id!=='owner') reject(403,'Human owner required');
          const operation=path.slice(bindingPath.length);
          const bindings=store.sessionBindings;
          if (operation==='inspect') return json(res,200,{binding:bindings.inspect(actor,await body(req))});
          if (operation==='set') return json(res,201,{binding:bindings.set(actor,await body(req))});
          if (operation==='retire') return json(res,200,{binding:bindings.retire(actor,await body(req))});
          if (operation==='receipt') return json(res,200,{receipt:bindings.receipt(actor,await body(req))});
        }
        if (method==='POST' && path==='/api/logout') {
          if (actor.kind!=='human') reject(403,'Human session required');
          store.revokeHumanSession(cookie(req));
          return json(res,200,{ok:true},{'Set-Cookie':cookieValue('',secureCookies,true)});
        }
        if (method==='GET' && path==='/api/session') return json(res,200,{user:actor,agents:store.listAgents(actor),...(modern?{imRealtime:true}: {})});
        if (modern && method==='POST' && path==='/api/humans') return json(res,201,store.provisionHuman(actor,await body(req)));
        if (method==='GET' && path==='/api/agents') return json(res,200,{agents:store.listAgents(actor)});
        if (method==='POST' && path==='/api/agents') return json(res,201,store.createAgent(actor,await body(req)));
        if (method==='POST' && path==='/api/rooms') return json(res,201,{room:store.createRoom(actor,await body(req))});
        if (method==='GET' && path==='/api/rooms') return json(res,200,{rooms:modern&&actor.kind==='human'?store.contacts.rooms(actor):store.listRooms(actor)});
        if (method==='GET' && path==='/api/hosts') return json(res,200,{hosts:store.hosts.list(actor)});
        if (method==='POST' && path==='/api/hosts') return json(res,201,store.hosts.register(actor,await body(req)));
        const hostOperation=/^\/api\/hosts\/([0-9a-z-]{1,80})\/(revoke|status-checks)$/i.exec(path);
        if (hostOperation) {
          const [,target,action]=hostOperation;
          if (method==='GET' && action==='status-checks') return json(res,200,{checks:store.hosts.listChecks(actor,target)});
          if (method==='POST' && action==='status-checks') return json(res,201,{check:store.hosts.requestCheck(actor,target,await body(req))});
          if (method==='POST' && action==='revoke') {
            const input=await body(req);
            if (Object.keys(input).length) reject(400,'Unrecognized request fields');
            return json(res,200,{host:store.hosts.revoke(actor,target)});
          }
        }
        if (method==='GET' && path==='/api/reminders') return json(res,200,{reminders:store.listReminders(actor)});
        if (method==='GET' && path==='/api/tasks') return json(res,200,{tasks:store.listTasks(actor)});
        if (method==='POST' && path==='/api/tasks') return json(res,201,{task:store.createTask(actor,await body(req))});
        if (method==='GET' && path==='/api/decisions') return json(res,200,{decisions:store.listDecisions(actor)});
        if (method==='POST' && path==='/api/decisions') return json(res,201,{decision:store.createDecision(actor,await body(req))});

        const roomRoute=/^\/api\/rooms\/([0-9a-z-]{1,80})(?:\/|$)/i.exec(path);
        if(!modern&&roomRoute&&store.contacts.isDirect(roomRoute[1])) reject(404,'Room not found');
        const readRoom=/^\/api\/rooms\/([0-9a-z-]{1,80})\/read$/i.exec(path);
        if(modern&&method==='POST'&&readRoom){
          if(actor.kind!=='human'||req.headers.authorization!==undefined) reject(403,'Human session required');
          const {advanced,...result}=store.contacts.markRead(actor,readRoom[1],(await body(req)).cursor);
          if(advanced) realtime.notifyRoomRead?.(actor.id,result.roomId);
          return json(res,200,result);
        }
        const members = /^\/api\/rooms\/([0-9a-z-]{1,80})\/members$/i.exec(path);
        if (members && method==='GET') return json(res,200,{members:store.listRoomMembers(actor,members[1])});
        if (members && method==='POST') {
          const input=await body(req);
          if (modern && Object.hasOwn(input,'humanId')) return json(res,200,store.setRoomHumanMember(actor,members[1],input.humanId,input.member));
          return json(res,200,store.setRoomMember(actor,members[1],input.agentId,input.member));
        }
        const messages = /^\/api\/rooms\/([0-9a-z-]{1,80})\/messages$/i.exec(path);
        if (messages && method==='GET') return json(res,200,store.listMessages(actor,messages[1],{
          after:url.searchParams.get('after'), limit:url.searchParams.get('limit'), thread:url.searchParams.get('thread'), consumer:url.searchParams.get('consumer'),
        }));
        if (messages && method==='POST') {
          const message=store.send(actor,messages[1],await body(req));
          realtime?.notifyRoom(messages[1]);
          return json(res,201,{message});
        }
        const media = /^\/api\/rooms\/([0-9a-z-]{1,80})\/attachments$/i.exec(path);
        if (modern && media && method==='POST') {
          if (actor.kind!=='human') reject(403,'Human session required');
          const message=await attachments.send(actor,media[1],req);
          realtime.notifyRoom(media[1]);
          return json(res,201,{message});
        }
        const messageAction = /^\/api\/rooms\/([0-9a-z-]{1,80})\/messages\/([0-9a-z-]{1,80})\/(attachment|retract)$/i.exec(path);
        if (modern && messageAction) {
          const [,roomId,messageId,operation]=messageAction;
          if (operation==='retract' && method==='POST') {
            if (actor.kind!=='human') reject(403,'Human session required');
            if (Object.keys(await body(req)).length) reject(400,'Unrecognized request fields');
            const message=await attachments.retract(actor,roomId,messageId);
            realtime.notifyRoom(roomId);
            return json(res,200,{message});
          }
          if (operation==='attachment' && ['GET','HEAD'].includes(method)) {
            const {attachment,bytes}=await attachments.get(actor,roomId,messageId);
            res.writeHead(200,{...publicSecurity,'Content-Type':attachment.mime,'Content-Length':bytes.length,
              'Content-Disposition':mediaDisposition(attachment)});
            return res.end(method==='HEAD'?undefined:bytes);
          }
        }
        const editAgent = /^\/api\/agents\/([0-9a-z-]{1,80})\/enabled$/i.exec(path);
        if (editAgent && method==='POST') return json(res,200,{agent:store.setAgentEnabled(actor,editAgent[1],(await body(req)).enabled)});
        const artifactPath = /^\/api\/tasks\/([0-9a-z-]{1,80})\/artifacts(?:\/([0-9a-z-]{1,80}))?$/i.exec(path);
        if (artifactPath) {
          const [,taskId,artifactId]=artifactPath;
          if (!artifactId && method==='GET') return json(res,200,{artifacts:store.artifacts.list(actor,taskId)});
          if (!artifactId && method==='POST') return json(res,201,{artifact:store.artifacts.create(actor,taskId,await body(req))});
          if (artifactId && ['GET','HEAD'].includes(method)) {
            const artifact=store.artifacts.get(actor,taskId,artifactId);
            res.writeHead(200,{...publicSecurity,'Content-Type':'text/plain; charset=utf-8','Content-Length':artifact.bytes,
              'Content-Disposition':artifactDisposition(artifact)});
            return res.end(method==='GET'?artifact.text:undefined);
          }
        }
        const updateTask = /^\/api\/tasks\/([0-9a-z-]{1,80})$/i.exec(path);
        if (updateTask && method==='PATCH') return json(res,200,{task:store.updateTask(actor,updateTask[1],await body(req))});
        const resolveDecision = /^\/api\/decisions\/([0-9a-z-]{1,80})\/resolve$/i.exec(path);
        if (resolveDecision && method==='POST') return json(res,200,{decision:store.resolveDecision(actor,resolveDecision[1],await body(req))});
        reject(404,'Route not found');
      }
      if (!webDir) reject(404,'Route not found');
      if (!['GET','HEAD'].includes(method)) reject(405,'Method not allowed');
      const pathname=decodeURIComponent(path);
      if (pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').some(part=>part==='..'||part==='.'||part.startsWith('.')))
        reject(404,'Asset not found');
      const root = await realpath(webDir).catch(()=>null);
      const target = root && await realpath(resolve(root,'.'+(pathname==='/'?'/index.html':pathname))).catch(()=>null);
      if (!root||!target||!within(root,target)||!mime[extname(target)]||!(await stat(target)).isFile()) reject(404,'Asset not found');
      const contents=await readFile(target);
      res.writeHead(200,{...publicSecurity,'Content-Type':mime[extname(target)],'Content-Length':contents.length});
      res.end(method==='HEAD'?undefined:contents);
    } catch (error) {
      const code = error instanceof URIError ? 400 : error.status??500;
      if (code>=500) console.error('Workspace request failed:',error.code??error.name);
      if (!res.headersSent) json(res,code,{error:code>=500?'Internal server error':error.message});
      else res.end();
    }
  });
  if (modern) {
    realtime=createRealtime(server,{
      authenticate:req=>store.authenticateHumanSession(cookie(req)),
      allowOrigin:req=>req.headers['sec-fetch-site']!=='cross-site'&&req.headers.origin===trustedOrigin(req),
      canReadRoom:(actor,id)=>store.canReadRoom(actor,id),
    });
    server.stopImRealtime=()=>realtime.close();
  }
  server.requestTimeout=20_000;
  server.headersTimeout=10_000;
  return server;
}
export async function main(env=process.env,{createRealtime=null}={}) {
  validateOwnerToken(env.WORKSPACE_TOKEN);
  const root = resolve(env.WORKSPACE_DATA_DIR??'data');
  await mkdir(root,{recursive:true,mode:0o700});
  const store=openWorkspace(join(root,'workspace.sqlite'),env.WORKSPACE_OWNER_NAME??'Owner');
  const host=env.WORKSPACE_HOST??'127.0.0.1', port=Number(env.WORKSPACE_PORT??'4319');
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid WORKSPACE_PORT');
  if (host!=='127.0.0.1' && host!=='::1') throw new Error('Only loopback binding is supported; use a separately authorized private TLS reverse proxy');
  const publicOrigin=env.WORKSPACE_PUBLIC_ORIGIN??null;
  const server=createWorkspaceServer({store,ownerToken:env.WORKSPACE_TOKEN,
    secureCookies:env.WORKSPACE_SECURE_COOKIES==='1'||publicOrigin?.startsWith('https://'),publicOrigin,
    ...(createRealtime?{webDir:null,imObjects:localImStorage(join(root,'objects')),createRealtime}: {})});
  server.listen(port,host,()=>console.log('Workspace listening on port ' + port));
  const stop=()=>{
    server.stopImRealtime?.();
    server.close(()=>{store.close();process.exitCode=0;});
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  return server;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
