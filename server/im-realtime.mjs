import { WebSocket, WebSocketServer } from 'ws';

const maxClients=128;
const maxBufferedBytes=64*1024;
const heartbeatMs=30_000;
const roomIdPattern=/^[a-z0-9-]{1,80}$/i;
const reasons={401:'Unauthorized',403:'Forbidden',404:'Not Found',503:'Service Unavailable'};

function rejectUpgrade(socket,status){
  socket.on('error',()=>socket.destroy());
  socket.setTimeout(1000,()=>socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reasons[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createImRealtime(server,{authenticate,allowOrigin,canReadRoom}){
  const service=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  const peers=new Map();
  function actorFor(request){
    try {
      const actor=authenticate(request);
      return actor?.kind==='human'&&typeof actor.id==='string' ? actor : null;
    } catch { return null; }
  }
  function current(socket,peer){
    const actor=actorFor(peer.request);
    if(actor?.id===peer.actorId) return actor;
    socket.close(1008,'Session unavailable');
    return null;
  }
  function upgrade(req,socket,head){
    if(req.url!=='/ws') return rejectUpgrade(socket,404);
    if(!req.headers.origin) return rejectUpgrade(socket,403);
    let allowed;
    try { allowed=allowOrigin(req); } catch { allowed=false; }
    if(allowed!==true) return rejectUpgrade(socket,403);
    const actor=req.headers.authorization===undefined ? actorFor(req) : null;
    if(!actor) return rejectUpgrade(socket,401);
    if(peers.size>=maxClients) return rejectUpgrade(socket,503);
    service.handleUpgrade(req,socket,head,client=>{
      peers.set(client,{request:req,actorId:actor.id,alive:true});
      client.on('error',()=>client.terminate());
      client.on('close',()=>peers.delete(client));
      client.on('pong',()=>{
        const peer=peers.get(client);
        if(peer) peer.alive=true;
      });
      client.on('message',()=>client.close(1008,'No client messages'));
    });
  }
  server.on('upgrade',upgrade);
  const heartbeat=setInterval(()=>{
    for(const [socket,peer] of peers){
      if(!peer.alive) socket.terminate();
      else if(socket.readyState===WebSocket.OPEN&&current(socket,peer)){
        peer.alive=false;
        socket.ping();
      }
    }
  },heartbeatMs);
  heartbeat.unref();

  return {
    notifyRoom(roomId){
      if(typeof roomId!=='string'||!roomIdPattern.test(roomId)) return;
      const data=JSON.stringify({type:'room.changed',roomId});
      for(const [socket,peer] of peers){
        if(socket.readyState!==WebSocket.OPEN) continue;
        const actor=current(socket,peer);
        if(!actor) continue;
        let allowed;
        try { allowed=canReadRoom(actor,roomId); } catch { allowed=false; }
        if(allowed!==true) continue;
        if(socket.bufferedAmount>maxBufferedBytes) socket.terminate();
        else socket.send(data);
      }
    },
    close(){
      server.off('upgrade',upgrade);
      clearInterval(heartbeat);
      for(const socket of peers.keys()) socket.terminate();
      service.close();
    },
  };
}
