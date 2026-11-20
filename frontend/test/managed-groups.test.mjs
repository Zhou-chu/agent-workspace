import { test } from 'node:test';
import assert from 'node:assert/strict';

test('group role policy never offers an operation the current human role cannot take', async ()=>{
  const {memberOperations, mayLeaveGroup, mayManageGroup}=await import('../public/managed-groups.mjs');
  assert.deepEqual(memberOperations('owner','owner',true),[]);
  assert.deepEqual(memberOperations('owner','member',false),['promote','transfer','remove']);
  assert.deepEqual(memberOperations('owner','admin',false),['demote','transfer','remove']);
  assert.deepEqual(memberOperations('admin','member',false),['remove']);
  assert.deepEqual(memberOperations('admin','owner',false),[]);
  assert.deepEqual(memberOperations('admin','admin',false),[]);
  assert.deepEqual(memberOperations('member','member',false),[]);
  assert.deepEqual(['owner','admin','member','guest'].map(mayManageGroup),[true,true,false,false]);
  assert.deepEqual(['owner','admin','member','guest'].map(mayLeaveGroup),[false,true,true,false]);
});

test('invitation review, recipient consent, and status notices are distinct', async ()=>{
  const {inviteOperations, inviteStatus}=await import('../public/managed-groups.mjs');
  const invite={inviterId:'sender',userId:'recipient',status:'pending_review'};
  assert.deepEqual(inviteOperations(invite,'sender',false),[]);
  assert.deepEqual(inviteOperations(invite,'recipient',false),[]);
  assert.deepEqual(inviteOperations(invite,'manager',true),['approve','reject']);
  invite.status='pending_acceptance';
  assert.deepEqual(inviteOperations(invite,'sender',false),[]);
  assert.deepEqual(inviteOperations(invite,'recipient',false),['accept','decline']);
  for(const status of ['accepted','rejected','declined','unknown']) {
    assert.deepEqual(inviteOperations({...invite,status},'recipient',true),[]);
  }
  assert.equal(inviteStatus('pending_review'),'等待管理员审核');
  assert.equal(inviteStatus('pending_acceptance'),'等待受邀人确认');
});
