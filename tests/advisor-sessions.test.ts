/**
 * 顾问会话的 session/event 回复捕获（#167 §5 Spike）：
 * 中间态不算最终回答，turn/end 才定；超时后完成的回合通过 onLateComplete 补发。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdvisorSessionAdapter } from '../plugins/zhiban-advisor/sessions.ts';
import {
  AdvisorSessionStore,
  MemoryAdvisorSessionBackend,
} from '../plugins/zhiban-advisor/domain.ts';

const SESSION = 'zhiban-advisor-adv_1';

function setup() {
  const listeners: Array<(...args: unknown[]) => void> = [];
  const ctx = {
    sessionController: {
      prompt: () => Promise.resolve(),
      resolveAgent: () => Promise.resolve({ error: 'NOT_FOUND' }),
      create: () => Promise.resolve({ sessionId: SESSION }),
    } as never,
    on: (_event: string, handler: (...args: unknown[]) => void) => {
      listeners.push(handler);
      return undefined;
    },
  };
  const sessions = new AdvisorSessionAdapter(ctx, {
    workspaceRoot: '/tmp/zhiban-test-advisors',
    store: new AdvisorSessionStore(new MemoryAdvisorSessionBackend()),
  });
  const dispatch = (event: unknown): void => {
    for (const listener of listeners) listener({ header: { id: SESSION } }, event);
  };
  const message = (text: string) => ({
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text }] } },
  });
  return { sessions, dispatch, message, listeners };
}

async function subscribed(listeners: unknown[]): Promise<void> {
  for (let i = 0; i < 50 && listeners.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(listeners.length > 0, 'session/event 订阅未建立');
}

test('回合完成：中间态不当最终回答，turn/end 取最后一条文本', async () => {
  const { sessions, dispatch, message, listeners } = setup();
  const turn = sessions.runTurn({ sessionId: SESSION, prompt: '汪女士血糖', timeoutMs: 1_000 });
  await subscribed(listeners);
  dispatch({ type: 'turn/start', data: { turn: 1 } });
  dispatch(message('我看一下。'));
  let settled = false;
  void turn.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '中间态不该当作结论');
  dispatch(message('汪女士最近一次血糖 5.8 mmol/L（空腹）。'));
  dispatch({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const outcome = await turn;
  assert.equal(outcome.status, 'completed');
  assert.match(outcome.text ?? '', /5\.8/);
  assert.equal(outcome.text?.includes('我看一下'), false);
});

test('回合结束但没产出文本 → empty', async () => {
  const { sessions, dispatch, listeners } = setup();
  const turn = sessions.runTurn({ sessionId: SESSION, prompt: '问题', timeoutMs: 1_000 });
  await subscribed(listeners);
  dispatch({ type: 'turn/start', data: { turn: 1 } });
  dispatch({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const outcome = await turn;
  assert.equal(outcome.status, 'empty');
});

test('中断但有前缀文本 → interrupted 并带回文本', async () => {
  const { sessions, dispatch, message, listeners } = setup();
  const turn = sessions.runTurn({ sessionId: SESSION, prompt: '问题', timeoutMs: 1_000 });
  await subscribed(listeners);
  dispatch({ type: 'turn/start', data: { turn: 1 } });
  dispatch({
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '查到了部分' }] }, interrupted: true },
  });
  dispatch({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  const outcome = await turn;
  assert.equal(outcome.status, 'interrupted');
  assert.match(outcome.text ?? '', /查到了部分/);
});

test('超时先回 timeout，后来完成时 onLateComplete 补发', async () => {
  const { sessions, dispatch, message, listeners } = setup();
  let late: string | undefined;
  const turn = sessions.runTurn({
    sessionId: SESSION,
    prompt: '问题',
    timeoutMs: 20,
    onLateComplete: (text) => {
      late = text;
    },
  });
  await subscribed(listeners);
  const outcome = await turn;
  assert.equal(outcome.status, 'timeout');
  // 稍后回合完成，补发回调应收到最终文本
  dispatch({ type: 'turn/start', data: { turn: 2 } });
  dispatch(message('查完了：血糖正常。'));
  dispatch({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  for (let i = 0; i < 100 && late === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.match(late ?? '', /血糖正常/);
});

test('ensure：会话记录可持久化', async () => {
  const { sessions } = setup();
  const record = await sessions.ensure('adv_1');
  assert.equal(record.sessionId, SESSION);
  const store = new AdvisorSessionStore(new MemoryAdvisorSessionBackend());
  store.save(record);
  assert.equal(store.get('adv_1')?.sessionId, SESSION);
});
