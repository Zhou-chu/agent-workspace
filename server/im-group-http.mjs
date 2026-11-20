const collection='/api/im/groups';
const inbox='/api/im/group-invites';
const groupRoute=/^\/api\/im\/groups\/([0-9a-z-]{1,80})(?:\/(invites|members|announcements|leave)(?:\/([0-9a-z-]{1,80}))?)?$/i;

export const isGroupPath=path=>path===collection||path===inbox||path.startsWith(collection+'/');

export async function handleGroupRequest({req,res,method,path,actor,groups,realtime,body,json,reject}){
  if(actor.kind!=='human'||req.headers.authorization!==undefined) reject(403,'Human session required');
  function notifyInvite(invite,presented){
    realtime.notifyGroupInvites?.(invite.roomId,invite.inviterId,presented?invite.userId:null);
  }
  if(path===inbox&&method==='GET') return json(res,200,{invites:groups.personalInvites(actor)});
  if(path===collection&&method==='POST'){
    const room=groups.create(actor,await body(req));
    realtime.notifyRoom(room.id);
    return json(res,201,{room});
  }
  const match=groupRoute.exec(path);
  if(!match) reject(404,'Group route not found');
  const [,roomId,area,target]=match;
  if(!area&&method==='GET') return json(res,200,groups.detail(actor,roomId));
  if(area==='invites'){
    if(!target&&method==='GET') return json(res,200,{invites:groups.groupInvites(actor,roomId)});
    if(!target&&method==='POST'){
      const {invite,changed,presented}=groups.invite(actor,roomId,(await body(req)).userId);
      if(changed) notifyInvite(invite,presented);
      return json(res,changed?201:200,{invite});
    }
    if(target&&method==='PATCH'){
      const {invite,changed,presented}=groups.decide(actor,roomId,target,(await body(req)).action);
      if(changed){
        notifyInvite(invite,presented);
        if(invite.status==='accepted') realtime.notifyRoom(roomId);
      }
      return json(res,200,{invite});
    }
  }
  if(area==='announcements'&&!target){
    if(method==='GET') return json(res,200,{announcements:groups.announcements(actor,roomId)});
    if(method==='POST'){
      const announcement=groups.announce(actor,roomId,await body(req));
      realtime.notifyRoom(roomId);
      return json(res,201,{announcement});
    }
  }
  if((area==='members'&&target&&method==='PATCH')||(area==='leave'&&!target&&method==='POST')){
    const action=area==='leave'?'leave':(await body(req)).action;
    const {userId,withdrawn}=area==='leave'?groups.leave(actor,roomId):groups.member(actor,roomId,target,action);
    if(action==='leave'||action==='remove') realtime.notifyGroupMembership?.(userId,roomId);
    for(const invite of withdrawn) notifyInvite(invite,invite.presented);
    realtime.notifyRoom(roomId);
    return json(res,200,{roomId,userId});
  }
  reject(404,'Group route not found');
}
