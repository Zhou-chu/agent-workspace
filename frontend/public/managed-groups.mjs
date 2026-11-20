export const mayManageGroup = role => role === 'owner' || role === 'admin';
export const mayLeaveGroup = role => role === 'admin' || role === 'member';

export function memberOperations(role, targetRole, self) {
  if (self) return [];
  if (role === 'owner' && targetRole === 'member') return ['promote','transfer','remove'];
  if (role === 'owner' && targetRole === 'admin') return ['demote','transfer','remove'];
  if (role === 'admin' && targetRole === 'member') return ['remove'];
  return [];
}

export function inviteOperations(invite, userId, managerQueue) {
  if (managerQueue && invite.status === 'pending_review') return ['approve','reject'];
  if (!managerQueue && invite.userId === userId && invite.status === 'pending_acceptance') return ['accept','decline'];
  return [];
}

export function inviteStatus(status) {
  switch (status) {
    case 'pending_review': return '等待管理员审核';
    case 'pending_acceptance': return '等待受邀人确认';
    case 'accepted': return '已接受';
    case 'rejected': return '审核未通过';
    case 'declined': return '已拒绝';
    default: return '状态未知';
  }
}

const titles = {owner:'群主', admin:'管理员', member:'成员'};
const inviteActions = {approve:'批准邀请', reject:'驳回邀请', accept:'接受群聊邀请', decline:'拒绝群聊邀请'};
const memberActions = {promote:'设为管理员', demote:'取消管理员', transfer:'转让群主', remove:'移出群聊'};
const confirmation = {transfer:'确认转让',remove:'确认移出',leave:'确认退出'};
const historyNotice = '加入后可以查看群聊历史消息与公告；在接受前无法查看。';
const endpoint = '/api/im/groups';

const patch = (api, path, action) => api(path,{method:'PATCH',data:{action}});
const routeFor = roomId => endpoint+'/'+encodeURIComponent(roomId);

function inviteList({el, button, listRows}, invites, userId, managerQueue, onAction, empty) {
  return listRows(invites, invite => {
    const actions = inviteOperations(invite,userId,managerQueue);
    const summary=managerQueue ? invite.inviterName+' 邀请 '+invite.userName
      : invite.userId===userId ? invite.inviterName+' 邀请你加入 '+invite.roomName
      : '你邀请 '+invite.userName+' 加入 '+invite.roomName;
    return el('div',{class:'group-invite-row'},el('strong',{},summary),el('span',{class:'muted'},inviteStatus(invite.status)),
      actions.includes('accept')?el('p',{class:'muted'},historyNotice):null,
      actions.length?el('div',{class:'row'},...actions.map(action=>button(inviteActions[action],
        event=>onAction(invite,action,event.currentTarget),{class:'subtle'}))):null);
  },empty);
}

export function createGroupInvites(ui, {userId, active, openRoom}) {
  const {el,iconButton,notice,api}=ui;
  const content=el('div',{class:'group-invite-content'});
  const info=notice('status');
  const panel=el('section',{id:'group-invites','aria-label':'群聊邀请',class:'contact-panel',hidden:''},info,content);
  let inFlight=false, queued=false, working=false, last;
  const opened=()=>active()&&!panel.hidden;
  const badge=el('span',{class:'group-invite-badge','aria-hidden':'true',hidden:''});
  const toggle=iconButton('群聊邀请','chat',()=>{
    panel.hidden=!panel.hidden;
    toggle.setAttribute('aria-expanded',String(!panel.hidden));
    void refresh();
  },{class:'icon-button group-invite-toggle','aria-controls':panel.id,'aria-expanded':'false'});
  toggle.append(badge);
  function close() {
    panel.hidden=true;
    toggle.setAttribute('aria-expanded','false');
  }
  panel.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.stopPropagation();close();toggle.focus();}
  });
  async function onAction(invite,action,control) {
    if(working) return;
    working=true;
    control.disabled=true;
    info.textContent='';
    try {
      await patch(api,routeFor(invite.roomId)+'/invites/'+encodeURIComponent(invite.id),action);
      if(!active()) return;
      if(action==='accept') {
        info.textContent='已加入群聊。';
        await openRoom(invite.roomId);
        if(active()) close();
      } else {
        info.textContent='已拒绝群聊邀请。';
        await refresh();
      }
    } catch(error) {
      if(opened()) info.textContent=error.message;
    } finally {working=false;control.disabled=false;}
  }
  async function refresh() {
    if(!active()) return;
    if(inFlight){queued=true;return;}
    inFlight=true;
    try {
      const {invites}=await api('/api/im/group-invites');
      if(!active()||queued) return;
      const count=invites.filter(invite=>invite.userId===userId&&invite.status==='pending_acceptance').length;
      badge.hidden=!count;
      badge.textContent=count>99?'99+':String(count);
      if(count) toggle.setAttribute('aria-description',count+' 个待确认群聊邀请');
      else toggle.removeAttribute('aria-description');
      if(opened()) {
        const view=JSON.stringify(invites);
        if(view!==last) {
          content.replaceChildren(inviteList(ui,invites,userId,false,onAction,'暂无群聊邀请'));
          last=view;
        }
      }
    } catch(error) {
      if(opened()) info.textContent=error.message;
    } finally {
      inFlight=false;
      if(queued){queued=false;void refresh();}
    }
  }
  return {toggle,panel,refresh,close};
}

export function createManagedMemberPanel(ui, {userId, active, roomId, onLeave}) {
  const {el,button,field,notice,api,post,listRows,humanTime}=ui;
  const base=routeFor(roomId);
  const info=notice('status');
  const body=el('div',{class:'group-admin-content'});
  const panel=el('div',{class:'member-panel managed-member-panel',hidden:''},info,body);
  let details, announcements=[], queue=[], friends, invitationOpen=false;
  let announcementDraft='', selectedFriend='', pendingConfirmation;
  let working=false, refreshing=false, queued=false;
  const opened=()=>active()&&!panel.hidden;

  async function execute(control, operation, success, after) {
    if(working) {
      if(opened()) info.textContent='正在处理上一项操作。';
      return;
    }
    working=true;
    info.textContent='';
    control.disabled=true;
    try {
      // Serialize mutations, not the background refresh. Once the server has
      // committed a write, the next still-permitted control can be used.
      try {await operation();}
      finally {working=false;}
      if(!active()) return;
      info.textContent=success;
      after?.();
      await refresh();
    } catch(error) {
      if(opened()) info.textContent=error.message;
    } finally {control.disabled=false;}
  }

  function memberRow(member, role) {
    const operations=memberOperations(role,member.role,member.id===userId);
    return el('div',{class:'group-member-row'},
      el('div',{class:'group-member-identity'},el('strong',{},member.displayName),el('span',{class:'badge'},titles[member.role]??'未知角色')),
      operations.length?el('div',{class:'row'},...operations.map(action=>button(memberActions[action],event=>{
        const patchMember=()=>patch(api,base+'/members/'+encodeURIComponent(member.id),action);
        if(confirmation[action]) {
          pendingConfirmation={action,memberId:member.id,name:member.displayName,run:patchMember};
          paint();
          panel.querySelector('[data-group-confirm]')?.focus();
        } else void execute(event.currentTarget,patchMember,'群成员角色已更新。');
      },{class:'subtle'}))):null);
  }

  function confirmBox(role) {
    const pending=pendingConfirmation;
    if(!pending) return null;
    const target=details.members.find(member=>member.id===pending.memberId);
    const allowed=pending.action==='leave'?mayLeaveGroup(role)
      :target&&memberOperations(role,target.role,target.id===userId).includes(pending.action);
    if(!allowed){pendingConfirmation=undefined;return null;}
    const text=pending.action==='leave'?'退出后将无法访问群聊与公告。'
      :pending.action==='transfer'?'确认把群主权限转让给 '+pending.name+'？你将成为普通成员。'
        :'确认移出 '+pending.name+'？对方将无法再访问该群。';
    return el('div',{class:'group-confirm'},el('p',{},text),el('div',{class:'row'},
      button(confirmation[pending.action],event=>execute(event.currentTarget,pending.run,'已更新群成员。',()=>{
        pendingConfirmation=undefined;
        if(pending.action==='leave') onLeave(roomId);
      }),{class:'primary','data-group-confirm':''}),
      button('取消',()=>{pendingConfirmation=undefined;paint();},{class:'subtle'})));
  }

  function inviteForm() {
    if(!invitationOpen) return null;
    if(!friends) return el('p',{role:'status'},'正在载入好友…');
    const currentMembers=new Set(details.members.map(member=>member.id));
    const choices=friends.filter(friend=>!currentMembers.has(friend.id));
    if(!choices.length) return el('p',{class:'muted'},'没有可邀请的好友。');
    const select=el('select',{required:'',onchange:()=>{selectedFriend=select.value;}},
      el('option',{value:''},'请选择好友'),...choices.map(friend=>el('option',{value:friend.id},friend.name)));
    select.value=choices.some(friend=>friend.id===selectedFriend)?selectedFriend:'';
    const send=el('button',{type:'submit',class:'primary'},'发送邀请');
    return el('form',{class:'group-form',onsubmit:event=>{
      event.preventDefault();
      const userId=select.value;
      if(!userId) return;
      void execute(send,()=>post(base+'/invites',{userId}),'已发出邀请。',()=>{
        selectedFriend='';
        invitationOpen=false;
      });
    }},field('选择好友',select),send);
  }

  async function toggleInviteForm() {
    invitationOpen=!invitationOpen;
    paint();
    if(!invitationOpen) return;
    try {
      const result=await api('/api/contacts');
      if(!opened()||!invitationOpen) return;
      friends=result.friends;
      paint();
      panel.querySelector('select')?.focus();
    } catch(error) {if(opened()) info.textContent=error.message;}
  }

  function announcementSection(role) {
    const input=el('textarea',{maxlength:'2000',required:'',rows:'2',oninput:()=>{announcementDraft=input.value;}});
    input.value=announcementDraft;
    const send=el('button',{type:'submit',class:'primary'},'发布公告');
    const form=el('form',{class:'group-form',onsubmit:event=>{
      event.preventDefault();
      const text=input.value.trim();
      if(!text) return;
      void execute(send,()=>post(base+'/announcements',{text}),'已发布公告。',()=>{announcementDraft='';});
    }},field('公告内容',input),send);
    return el('section',{'aria-label':'群公告'},el('h2',{},'群公告'),mayManageGroup(role)?form:null,
      listRows(announcements,announcement=>{
        const author=details.members.find(member=>member.id===announcement.authorId);
        return el('article',{class:'group-announcement'},el('p',{},announcement.text),
          el('span',{class:'muted'},[author?.displayName,humanTime(announcement.createdAt)].filter(Boolean).join(' · ')));
      },'暂无公告'));
  }

  function paint() {
    if(!opened()||!details) return;
    const role=details.role;
    body.replaceChildren(
      el('section',{'aria-label':'群成员'},
        el('h2',{},'群成员'),el('p',{class:'muted'},'你的角色：'+(titles[role]??'未知角色')),
        listRows(details.members,member=>memberRow(member,role),'暂无群成员'),
        confirmBox(role),
        el('div',{class:'row'},button('邀请好友',()=>{void toggleInviteForm();},{class:'subtle','aria-expanded':String(invitationOpen)}),
          mayLeaveGroup(role)?button('退出群聊',()=>{
            pendingConfirmation={action:'leave',run:()=>post(base+'/leave',{})};
            paint();
            panel.querySelector('[data-group-confirm]')?.focus();
          },{class:'subtle'}):null),
        inviteForm()),
      mayManageGroup(role)?el('section',{'aria-label':'待审核邀请'},el('h2',{},'待审核邀请'),
        inviteList(ui,queue,userId,true,(invite,action,control)=>execute(control,
          ()=>patch(api,base+'/invites/'+encodeURIComponent(invite.id),action),'已处理群聊邀请。'),'暂无待审核邀请')):null,
      announcementSection(role));
  }

  async function refresh() {
    if(!opened()) return;
    if(refreshing){queued=true;return;}
    refreshing=true;
    try {
      const previous=JSON.stringify([details,announcements,queue]);
      const [next,news]=await Promise.all([api(base),api(base+'/announcements')]);
      if(!opened()) return;
      const pending=mayManageGroup(next.role)?(await api(base+'/invites')).invites:[];
      if(!opened()||queued) return;
      details=next;
      announcements=news.announcements;
      queue=pending.filter(invite=>invite.status==='pending_review');
      if(previous!==JSON.stringify([details,announcements,queue])||!body.childElementCount) paint();
    } catch(error) {
      if(opened()) info.textContent=error.message;
    } finally {
      refreshing=false;
      if(queued){queued=false;void refresh();}
    }
  }
  return {panel,refresh};
}
