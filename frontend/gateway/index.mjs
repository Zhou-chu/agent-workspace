import { createServer, request, STATUS_CODES } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distDefault=fileURLToPath(new URL('../dist/',import.meta.url));
const mime=new Map([
  ['.html','text/html; charset=utf-8'],
  ['.mjs','text/javascript; charset=utf-8'],
  ['.css','text/css; charset=utf-8'],
]);
const staticSecurity={
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'Permissions-Policy':'geolocation=(), microphone=(self), camera=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control':'no-store',
};
const response=(res,status,message)=>res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end(message);
const apiPath=path=>path==='/api'||path.startsWith('/api/');
const wsPath=path=>path==='/ws';
const apiSegments=/^\/api(?:\/[a-z0-9-]{1,80})*$/i;
const pathOf=req=>req.url?.startsWith('/')&&!req.url.startsWith('//')?req.url.split('?',1)[0]:null;
const hop=new Set(['connection','upgrade','keep-alive','proxy-authenticate','proxy-authorization','proxy-connection','te','trailer','transfer-encoding']);

function endToEnd(headers) {
  const connection=new Set((headers.connection??'').toLowerCase().split(',').map(value=>value.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([key])=>!hop.has(key)&&!connection.has(key)));
}

function backendAddress(value) {
  const url=URL.parse(value??'');
  if (!url || url.origin!==value || url.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || !url.port) {
    throw new Error('AGENTCHAT_BACKEND_ORIGIN must be an explicit loopback HTTP origin and port, e.g. http://127.0.0.1:4319');
  }
  return {hostname:url.hostname==='[::1]'?'::1':'127.0.0.1',port:Number(url.port)};
}

function apiTarget(raw,path) {
  // The destination is fixed at startup. Only simple route components and
  // individually encoded query names/values may enter its request target.
  if(!apiSegments.test(path)) return null;
  const segments=path.slice(1).split('/').map(encodeURIComponent);
  const query=new URLSearchParams(raw.slice(path.length+1));
  const pairs=Array.from(query,([name,value])=>encodeURIComponent(name)+'='+encodeURIComponent(value));
  return '/'+segments.join('/')+(pairs.length?'?'+pairs.join('&'):'');
}

function forwardHttp(req,res,backend,path) {
  const target=apiTarget(req.url,path);
  if(target===null) return response(res,400,'Invalid API path');
  const out=request({...backend,method:req.method,path:target,headers:endToEnd(req.headers)},upstream=>{
    upstream.once('error',()=>res.destroy());
    res.writeHead(upstream.statusCode,endToEnd(upstream.headers));
    upstream.pipe(res);
  });
  out.setTimeout(20_000,()=>out.destroy());
  out.once('error',()=>res.headersSent?res.destroy():response(res,502,'AgentChat backend unavailable'));
  res.once('close',()=>out.destroy());
  req.once('error',()=>out.destroy());
  req.pipe(out);
}

function rejectUpgrade(socket,status) {
  socket.end('HTTP/1.1 '+status+' '+STATUS_CODES[status]+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function forwardUpgrade(req,client,head,backend) {
  client.on('error',()=>client.destroy());
  if (!wsPath(req.url)) return rejectUpgrade(client,404);
  if (req.method!=='GET'||req.headers.upgrade?.toLowerCase()!=='websocket') return rejectUpgrade(client,400);
  const headers={...endToEnd(req.headers),connection:'Upgrade',upgrade:'websocket'};
  const out=request({...backend,method:'GET',path:'/ws',headers});
  out.setTimeout(10_000,()=>out.destroy());
  out.once('response',res=>{
    res.resume();
    rejectUpgrade(client,res.statusCode);
  });
  out.once('error',()=>rejectUpgrade(client,502));
  client.once('close',()=>out.destroy());
  out.once('upgrade',(res,socket,firstBytes)=>{
    socket.setTimeout(0);
    socket.once('error',()=>client.destroy());
    client.once('error',()=>socket.destroy());
    socket.once('close',()=>client.destroy());
    client.once('close',()=>socket.destroy());
    const headerLines=res.rawHeaders.flatMap((name,index,arr)=>index%2?[]:[name+': '+arr[index+1]]);
    client.write(['HTTP/1.1 101 Switching Protocols',...headerLines,'',''].join('\r\n'));
    if (firstBytes.length) client.write(firstBytes);
    if (head.length) socket.write(head);
    client.pipe(socket).pipe(client);
  });
  out.end();
}

export async function createFrontendServer({backendOrigin,distDir=distDefault}={}) {
  const backend=backendAddress(backendOrigin);
  // Cache only known root-level browser assets, not modules or files adjacent to dist.
  const index=await readFile(join(distDir,'index.html')).catch(error=>{
    throw new Error('AgentChat frontend build is missing; run npm --prefix frontend run build',{cause:error});
  });
  const staticAssets=new Map([['/index.html',[index,mime.get('.html')]]]);
  for (const entry of await readdir(distDir,{withFileTypes:true})) {
    const asset=/^[a-z0-9-]+(\.mjs|\.css)$/.exec(entry.name);
    if (entry.isFile()&&asset) {
      staticAssets.set('/'+entry.name,[await readFile(join(distDir,entry.name)),mime.get(asset[1])]);
    }
  }
  for(const asset of ['/app.mjs','/styles.css']) {
    if(!staticAssets.has(asset)) throw new Error('AgentChat frontend build is missing '+asset);
  }
  const server=createServer((req,res)=>{
    const path=pathOf(req);
    if (!path) return response(res,400,'Invalid request path');
    if (apiPath(path)) return forwardHttp(req,res,backend,path);
    if (!['GET','HEAD'].includes(req.method)) return response(res,405,'Method not allowed');
    if (path==='/healthz') return res.writeHead(200,{'Cache-Control':'no-store'}).end();
    if (wsPath(path)) return response(res,426,'WebSocket upgrade required');
    const asset=staticAssets.get(path==='/'?'/index.html':path);
    if (!asset) return response(res,404,'Asset not found');
    const [body,type]=asset;
    res.writeHead(200,{...staticSecurity,'Content-Type':type,'Content-Length':body.length});
    return res.end(req.method==='HEAD'?undefined:body);
  });
  server.on('upgrade',(req,socket,head)=>forwardUpgrade(req,socket,head,backend));
  server.requestTimeout=20_000;
  server.headersTimeout=10_000;
  return server;
}

export async function main(env=process.env) {
  const host=env.AGENTCHAT_FRONTEND_HOST??'127.0.0.1';
  const port=Number(env.AGENTCHAT_FRONTEND_PORT??4320);
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid AGENTCHAT_FRONTEND_PORT');
  const origin=env.AGENTCHAT_BACKEND_ORIGIN;
  if (backendAddress(origin).port===port) throw new Error('AgentChat frontend and backend must use different ports');
  const server=await createFrontendServer({backendOrigin:origin});
  server.listen(port,host,()=>console.log('AgentChat frontend ready at '+host+':'+port));
  return server;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) await main();
