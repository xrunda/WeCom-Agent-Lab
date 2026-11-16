/**
 * 顾问 1:1 路由决策（#167 §9）：快捷指令 / Agent / 降级三条路径。
 * 全部虚构数据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeSingleText } from '../plugins/zhiban-wecom/advisor-route.ts';

function route(text: string, input: Partial<Parameters<typeof routeSingleText>[0]> = {}) {
  return routeSingleText({
    text,
    advisorId: 'adv_1',
    advisorAvailable: true,
    todoReply: (advisorId) => (text.includes('待办') ? `待办回复 ${advisorId}` : undefined),
    ...input,
  });
}

test('帮助 / 指令 / 能做什么 → 静态文案', () => {
  for (const text of ['帮助', '指令', '能做什么']) {
    const action = route(text);
    assert.equal(action.kind, 'reply');
    assert.match(action.text, /可用指令/);
    assert.match(action.text, /重置对话/);
  }
});

test('我的待办 → 秒回（共用 format 的待办文案）', () => {
  const action = route('我的待办');
  assert.deepEqual(action, { kind: 'reply', text: '待办回复 adv_1' });
  assert.equal(route('今天待办').kind, 'reply');
});

test('重置对话 → 会话动作；Agent 不可用时给提示', () => {
  assert.equal(route('重置对话').kind, 'reset');
  const unavailable = route('重置对话', { advisorAvailable: false });
  assert.equal(unavailable.kind, 'reply');
  assert.match(unavailable.text, /重置对话/);
});

test('纯编号 1-9 → 选择；不是 1-9 的普通数字不劫持', () => {
  assert.deepEqual(route('1'), { kind: 'selection', number: 1 });
  assert.deepEqual(route('9'), { kind: 'selection', number: 9 });
  const unavailable = route('1', { advisorAvailable: false });
  assert.equal(unavailable.kind, 'reply');
  assert.match(unavailable.text, /编号/);
});

test('知识 / 话术 / 为什么红线等退役关键词 → 交给 Agent，不再关键词匹配', () => {
  for (const text of ['知识 饮食', '话术 复诊', '为什么红线', '我的草稿', '为什么警告?']) {
    const action = route(text);
    assert.equal(action.kind, 'agent', text);
    assert.equal(action.text, text);
  }
});

test('Agent 不可用时 → 降级（有活动草稿当改稿 / 用法提示由运行时处理）', () => {
  const action = route('汪女士最近血糖怎么样', { advisorAvailable: false });
  assert.equal(action.kind, 'fallback');
});

test('未知顾问（没有 advisorId）即使 Agent 可用也不发回合', () => {
  const action = routeSingleText({
    text: '你好',
    advisorId: undefined,
    advisorAvailable: true,
    todoReply: () => undefined,
  });
  assert.equal(action.kind, 'fallback');
});
