const hostLabels = new Map([
  ['never_seen', '尚未连接'], ['online', '在线'], ['offline', '离线'], ['revoked', '已撤销'],
]);
const checkLabels = new Map([
  ['pending', '等待设备领取'], ['claimed', '已领取，等待回执'], ['completed', '已收到回执'],
  ['uncertain', '结果待核对'], ['expired', '已过期'], ['cancelled', '已取消'],
]);

export const hostStatus = value => hostLabels.get(value) ?? '未知';
export const checkStatus = value => checkLabels.get(value) ?? '未知';
export const mayRequestCheck = value => value === 'online';
export const nextCheckRequestId = (unacknowledged, create) => unacknowledged ?? create();
