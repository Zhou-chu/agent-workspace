import { randomUUID, createHash } from 'node:crypto';
import { createLocalStorage, MAX_OBJECT_BYTES } from '../storage/index.mjs';
import { reject } from './workspace.mjs';

export const localImStorage = directory => createLocalStorage({directory});
const byImageType = new Map([
  ['image/png', bytes => bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))],
  ['image/jpeg', bytes => bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))],
  ['image/webp', bytes => bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP'],
  ['image/gif', bytes => ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())],
]);
const voiceType = 'audio/webm';
const fileType = 'application/octet-stream';

async function readBounded(req) {
  if (Number(req.headers['content-length'])>MAX_OBJECT_BYTES) {
    req.resume();
    reject(413,'Attachment is too large (10 MiB limit)');
  }
  return new Promise((resolve,rejectRead)=>{
    let size=0, stopped=false;
    const chunks=[];
    req.on('data',chunk=>{
      if(stopped) return;
      size+=chunk.length;
      if(size>MAX_OBJECT_BYTES) {
        stopped=true; chunks.length=0;
        rejectRead(Object.assign(new Error('Attachment is too large (10 MiB limit)'),{status:413}));
      } else chunks.push(chunk);
    });
    req.on('error',rejectRead);
    req.on('end',()=>{
      if(stopped) return;
      if(!size) rejectRead(Object.assign(new Error('Attachment is empty'),{status:400}));
      else resolve(Buffer.concat(chunks,size));
    });
  });
}
function getName(encoded) {
  let name;
  try { name=decodeURIComponent(encoded??''); }
  catch { reject(400,'Invalid attachment name'); }
  if(!name || name.length>120 || name.trim()!==name || name==='.' || name==='..' || /[\/\\\u0000-\u001f\u007f]/u.test(name)) reject(400,'Invalid attachment name');
  return name;
}
function mediaType(kind,type,bytes) {
  if(kind==='file') return fileType;
  if(kind==='image'&&byImageType.get(type)?.(bytes)) return type;
  if(kind==='voice'&&type===voiceType&&bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))) return voiceType;
  reject(415,'Unsupported image or voice format');
}
export const mediaDisposition = ({name,kind}) => {
  const encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return (kind==='file'?'attachment':'inline') + '; filename="agentchat-media"; filename*=UTF-8\'\'' + encoded;
};

export function attachmentService({store,objects}) {
  const cleanup = async id => {
    try { await objects.delete(id); }
    catch { console.warn('AgentChat attachment cleanup remains pending'); }
  };
  return {
    async send(actor,roomId,req) {
      store.requireRoomMember(actor,roomId);
      const kind=req.headers['x-agentchat-media-kind'];
      const name=getName(req.headers['x-agentchat-file-name']);
      const clientRequestId=req.headers['x-agentchat-request-id'];
      if(!['file','image','voice'].includes(kind)||typeof clientRequestId!=='string'||!/^[a-z0-9_-]{1,100}$/i.test(clientRequestId)) reject(400,'Invalid attachment request');
      const bytes=await readBounded(req);
      const mime=mediaType(kind,req.headers['content-type']?.split(';',1)[0].toLowerCase(),bytes);
      const id=randomUUID(), sha256=createHash('sha256').update(bytes).digest('hex');
      store.requireRoomMember(actor,roomId);
      await objects.put(id,bytes);
      try {
        const message=store.send(actor,roomId,{clientRequestId,body:''},{id,name,mime,kind,size:bytes.length,sha256});
        if(message.attachment?.id!==id) await cleanup(id);
        return message;
      } catch(error) {
        await cleanup(id);
        throw error;
      }
    },
    async get(actor,roomId,messageId){
      const attachment=store.getMessageAttachment(actor,roomId,messageId);
      const bytes=await objects.get(attachment.id);
      store.getMessageAttachment(actor,roomId,messageId);
      if(!bytes || bytes.length!==attachment.size) reject(404,'Attachment not found');
      return {attachment,bytes};
    },
    async retract(actor,roomId,messageId){
      let attachment;
      try { attachment=store.getMessageAttachment(actor,roomId,messageId); }
      catch(error) { if(error.status!==404) throw error; }
      const message=store.retractMessage(actor,roomId,messageId);
      if(attachment) await cleanup(attachment.id);
      return message;
    },
  };
}
