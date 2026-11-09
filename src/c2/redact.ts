/**
 * 日志脱敏：C2 的日志只允许出现消息元数据，不允许出现正文。
 *
 * 约束来自 #31：msgid 只留尾号、roomid 只留尾号、发送者只留类型。
 * 这里集中实现，避免各模块各写一套后再次泄漏。
 */

/** 只保留 id 的尾号；短 id 本身就没有可隐藏的前缀，原样返回 */
export function tailId(id: string | undefined | null, size = 6): string {
  if (!id) return '-';
  return id.length <= size ? id : `…${id.slice(-size)}`;
}

/**
 * 发送者类型，不暴露具体 userid：
 * - action=send 是企业成员发出
 * - wm 开头是外部客户的个人微信 id
 * - 其余无法判断，记为 unknown
 */
export type SenderType = 'employee' | 'external' | 'unknown';

export function senderType(from: string | undefined, action?: 'send' | 'recv'): SenderType {
  if (action === 'send') return 'employee';
  if (from?.startsWith('wm')) return 'external';
  return 'unknown';
}

export interface MessageMeta {
  msgid?: string;
  roomid?: string;
  msgtype?: string;
  from?: string;
  action?: 'send' | 'recv';
}

/** 一条消息的脱敏描述；调用方不得再把正文拼进来 */
export function describeMessageMeta(meta: MessageMeta): string {
  const room = meta.roomid ? `room=${tailId(meta.roomid)}` : 'room=单聊';
  return (
    `msgid=${tailId(meta.msgid)} msgtype=${meta.msgtype ?? '-'} ` +
    `${room} sender=${senderType(meta.from, meta.action)}`
  );
}
