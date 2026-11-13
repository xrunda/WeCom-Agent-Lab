/**
 * #146 待回复索引：判定、合并、关闭与幂等。
 * 全部使用虚构数据，不接触真实群或存档。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuditEvent } from '../src/c2/types.ts';
import {
  SidebarService,
  dmConvKey,
  groupConvKey,
  replyExpectation,
} from '../src/p1/sidebar.ts';
import type {
  PendingItem,
  SidebarBackend,
  SidebarMessageInput,
} from '../src/p1/sidebar.ts';

const ROOM = groupConvKey('room_test_1');
const DM = dmConvKey('staff_1', 'wm_customer_1');
const T0 = 1_700_000_000_000;
const MIN = 60_000;

class MemoryBackend implements SidebarBackend {
  readonly items = new Map<string, PendingItem>();
  readonly seen = new Map<string, number>();
  readonly audits: AuditEvent[] = [];

  loadItems(): PendingItem[] {
    return [...this.items.values()].map((item) => structuredClone(item));
  }

  putItem(item: PendingItem): Promise<void> {
    this.items.set(item.id, structuredClone(item));
    return Promise.resolve();
  }

  loadSeen(): Array<{ msgid: string; at: number }> {
    return [...this.seen].map(([msgid, at]) => ({ msgid, at }));
  }

  putSeen(msgid: string, at: number): Promise<void> {
    this.seen.set(msgid, at);
    return Promise.resolve();
  }

  appendAudit(event: AuditEvent): Promise<void> {
    this.audits.push(event);
    return Promise.resolve();
  }
}

function service(backend = new MemoryBackend(), now = T0 + 100 * MIN) {
  return new SidebarService({ backend, now: () => now });
}

let seq = 0;
function message(
  convKey: string,
  senderId: string,
  text: string,
  at: number,
  overrides: Partial<SidebarMessageInput> = {},
): SidebarMessageInput {
  seq += 1;
  return {
    msgid: `msg_${seq}`,
    convKey,
    kind: convKey.startsWith('dm:') ? 'dm' : 'group',
    ...(convKey.startsWith('room:') ? { roomId: convKey.slice('room:'.length) } : {}),
    senderId,
    msgtype: 'text',
    text,
    at,
    ...overrides,
  };
}

test('需要回应的判定：疑问、请求、@ 命中；寒暄不建档', () => {
  assert.equal(replyExpectation('明天几点复诊？', 'text'), 'question');
  assert.equal(replyExpectation('麻烦帮我看看这个药', 'text'), 'request');
  assert.equal(replyExpectation('@李医生 在吗', 'text'), 'mention');
  assert.equal(replyExpectation('我今天头晕', 'text'), 'ambiguous');
  assert.equal(replyExpectation('好的', 'text'), undefined);
  assert.equal(replyExpectation('收到，谢谢！', 'text'), undefined);
  assert.equal(replyExpectation('好的，那我明天还吃这个药吗', 'text'), 'question');
  assert.equal(replyExpectation('', 'text'), undefined);
  assert.equal(replyExpectation('图片', 'image'), undefined);
});

test('客户连发多条合并成一条，原文取最新，条数累计', () => {
  const svc = service();
  svc.observe(message(ROOM, 'wm_a', '在吗', T0));
  svc.observe(message(ROOM, 'wm_a', '我血压有点高', T0 + MIN));
  svc.observe(message(ROOM, 'wm_a', '要不要紧？', T0 + 2 * MIN));

  const open = svc.openItems(ROOM);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.messageCount, 3);
  assert.equal(open[0]!.firstAt, T0);
  assert.equal(open[0]!.lastAt, T0 + 2 * MIN);
  assert.equal(open[0]!.excerpt, '要不要紧？');
  assert.equal(open[0]!.reason, 'question');
});

test('超过合并窗口的消息另起一条', () => {
  const svc = service();
  svc.observe(message(ROOM, 'wm_a', '明天几点复诊？', T0));
  svc.observe(message(ROOM, 'wm_a', '那我需要空腹吗？', T0 + 11 * MIN));
  assert.equal(svc.openItems(ROOM).length, 2);
});

test('顾问在群里回复后自动关闭更早的条目，并记录回复人', () => {
  const svc = service();
  svc.observe(message(ROOM, 'wm_a', '明天几点复诊？', T0));
  svc.observe(message(ROOM, 'staff_1', '上午九点，记得空腹', T0 + MIN));

  const open = svc.openItems(ROOM);
  assert.equal(open.length, 0);
  const closed = svc.recentlyClosed(ROOM);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.status, 'replied');
  assert.equal(closed[0]!.closedBy, 'staff_1');
  assert.equal(closed[0]!.closedReason, 'staff_reply');
});

test('机器人回复不算顾问回复，只标记已回应', () => {
  const backend = new MemoryBackend();
  const svc = new SidebarService({
    backend,
    now: () => T0 + MIN,
    botUserIds: ['bot_1'],
  });
  svc.observe(message(ROOM, 'wm_a', '明天几点复诊？', T0));
  svc.observe(message(ROOM, 'bot_1', '已收到，顾问稍后回复您', T0 + 1000));

  const open = svc.openItems(ROOM);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.botRepliedAt, T0 + 1000);
});

test('同事回复也算已回应，并记录是谁', () => {
  const svc = service();
  svc.observe(message(ROOM, 'wm_a', '明天几点复诊？', T0));
  svc.observe(message(ROOM, 'staff_2', '九点', T0 + MIN));
  const closed = svc.recentlyClosed(ROOM);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.closedBy, 'staff_2');
});

test('不同客户各成一条，不因其中一人被回复而丢失另一人的问题', () => {
  const svc = service();
  svc.observe(message(ROOM, 'wm_a', '我明天几点复诊？', T0));
  svc.observe(message(ROOM, 'wm_b', '我的药快吃完了', T0 + MIN));
  assert.equal(svc.openItems(ROOM).length, 2);

  svc.observe(message(ROOM, 'staff_1', '王阿姨九点，李叔的药我下午寄', T0 + 2 * MIN));
  assert.equal(svc.openItems(ROOM).length, 0);
  assert.equal(svc.recentlyClosed(ROOM).length, 2);
});

test('同一条消息重复投递只计一次', () => {
  const svc = service();
  const msg = message(ROOM, 'wm_a', '明天几点复诊？', T0);
  svc.observe(msg);
  svc.observe(msg);
  const open = svc.openItems(ROOM);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.messageCount, 1);
});

test('手动关闭写审计且不带正文', () => {
  const backend = new MemoryBackend();
  const svc = new SidebarService({ backend, now: () => T0 + MIN });
  const { item } = svc.observe(message(ROOM, 'wm_a', '明天几点复诊？', T0));
  assert.ok(item);

  const closed = svc.close(item!.id, 'dismissed', 'staff_1');
  assert.equal(closed?.status, 'dismissed');
  assert.equal(closed?.closedReason, 'manual');
  assert.equal(backend.audits.length, 1);
  assert.equal(backend.audits[0]!.action, 'sidebar.pending.close');
  assert.doesNotMatch(JSON.stringify(backend.audits[0]), /复诊/);

  // 重复关闭无副作用
  assert.equal(svc.close(item!.id, 'dismissed', 'staff_1'), undefined);
});

test('单聊会话键独立于群会话，互不串数据', () => {
  const svc = service();
  svc.observe(message(DM, 'wm_customer_1', '明天几点复诊？', T0, { senderKind: 'external' }));
  assert.equal(svc.openItems(DM).length, 1);
  assert.equal(svc.openItems(ROOM).length, 0);

  svc.observe(message(DM, 'staff_1', '九点', T0 + MIN));
  assert.equal(svc.openItems(DM).length, 0);
});

test('重启后从持久化恢复开放条目与幂等记录', () => {
  const backend = new MemoryBackend();
  const first = new SidebarService({ backend, now: () => T0 });
  const msg = message(ROOM, 'wm_a', '明天几点复诊？', T0);
  const { item } = first.observe(msg);
  assert.ok(item);

  const second = new SidebarService({ backend, now: () => T0 + MIN });
  assert.equal(second.openItems(ROOM).length, 1);
  // 同一条消息再次出现不会重复建档
  second.observe(msg);
  assert.equal(second.openItems(ROOM).length, 1);
});

test('裁剪只清理过期关闭条目与已见记录，开放条目保留', () => {
  const backend = new MemoryBackend();
  const svc = new SidebarService({
    backend,
    now: () => T0 + 30 * 24 * 60 * MIN,
    seenRetentionMs: 7 * 24 * 60 * MIN,
    closedRetentionMs: 7 * 24 * 60 * MIN,
  });
  svc.observe(message(ROOM, 'wm_a', '明天几点复诊？', T0));
  svc.observe(message(ROOM, 'staff_1', '九点', T0 + MIN));
  svc.observe(message(ROOM, 'wm_b', '我的药快吃完了', T0 + 2 * MIN));

  svc.prune(T0 + 30 * 24 * 60 * MIN);
  const items = svc.allItems();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.status, 'open');
});
