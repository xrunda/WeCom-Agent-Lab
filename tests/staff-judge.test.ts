import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStaffJudgePrompt,
  parseStaffVerdict,
  StaffJudge,
} from '../src/p1/staff-judge.ts';
import { extractAssistantText, StaffJudgeSession } from '../plugins/zhiban-patient/staff-judge.ts';
import { decideStaffQuality } from '../plugins/zhiban-wecom/index.ts';

test('语义复核提示词：带规则名与发言原文，要求只输出一行 JSON', () => {
  const prompt = buildStaffJudgePrompt({
    text: '您这不是糖尿病，不用太担心。',
    ruleNames: ['不诊断'],
  });
  assert.equal(prompt.includes('不诊断'), true);
  assert.equal(prompt.includes('您这不是糖尿病，不用太担心。'), true);
  assert.equal(prompt.includes('"violation"'), true);
  assert.equal(prompt.includes('不算违规'), true);
});

test('语义复核提示词：超长发言截断到 2000 字，不把整段塞进模型', () => {
  const text = '叮嘱'.repeat(2_000);
  const prompt = buildStaffJudgePrompt({ text, ruleNames: ['不诊断'] });
  assert.equal(prompt.includes(text), false);
  assert.equal(prompt.includes(text.slice(0, 2_000)), true);
});

test('语义复核结果：严格解析 JSON，模型不按格式输出时判 unknown', () => {
  assert.equal(parseStaffVerdict('{"violation": true, "reason": "直接下了结论"}'), 'violation');
  assert.equal(parseStaffVerdict('{"violation": false, "reason": "科普知识"}'), 'ok');
  // 前后带解释文字时取最外层 JSON
  assert.equal(parseStaffVerdict('判断如下：\n{"violation": true}\n以上。'), 'violation');
  // 不能用字符串冒充布尔
  assert.equal(parseStaffVerdict('{"violation": "false"}'), 'unknown');
  assert.equal(parseStaffVerdict('{"result": false}'), 'unknown');
  assert.equal(parseStaffVerdict('不违规'), 'unknown');
  assert.equal(parseStaffVerdict(''), 'unknown');
});

test('语义复核：模型抛错时返回 unknown，由调用方保守告警', async () => {
  const judge = new StaffJudge({
    ask: () => Promise.reject(new Error('MODEL_DOWN')),
  });
  assert.equal(await judge.judge({ text: '这就是诊断。', ruleNames: ['不诊断'] }), 'unknown');
});

test('语义复核：把端口返回值原样交给解析', async () => {
  const seen: string[] = [];
  const judge = new StaffJudge({
    ask: (prompt) => {
      seen.push(prompt);
      return Promise.resolve('{"violation": false}');
    },
  });
  assert.equal(await judge.judge({ text: '建议去医院做个检查。', ruleNames: ['不诊断'] }), 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.includes('建议去医院做个检查。'), true);
});

test('会话事件：只从 assistant/message 的文本块取正文', () => {
  const event = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '{"violation":false}' }] } },
  };
  assert.equal(extractAssistantText(event), '{"violation":false}');
  assert.equal(extractAssistantText({ type: 'user/message', data: {} }), undefined);
  assert.equal(
    extractAssistantText({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool_use', name: 'x' }] } },
    }),
    undefined,
  );
  assert.equal(extractAssistantText(null), undefined);
});

test('语义复核会话：同一时刻只跑一条，忙时新请求直接拒绝（调用方按保守策略告警）', async () => {
  const prompts: string[] = [];
  const resolvers: Array<() => void> = [];
  const listeners: Array<(...args: unknown[]) => void> = [];
  const ctx = {
    sessionController: {
      prompt: (request: { content: Array<{ text?: string }> }, _signal: AbortSignal) => {
        prompts.push(request.content[0]?.text ?? '');
        return new Promise<void>((resolve) => {
          resolvers.push(() => resolve());
          // 模拟宿主：提问后立刻回一条助手消息
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({ header: { id: 'zhiban-guard-review' } }, {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: '{"violation":true}' }] } },
              });
            }
          });
        });
      },
      resolveAgent: () => Promise.resolve({ error: 'NOT_FOUND' }),
      create: () => Promise.resolve({ sessionId: 'zhiban-guard-review' }),
    } as never,
    on: (_event: string, handler: (...args: unknown[]) => void) => {
      listeners.push(handler);
      return undefined;
    },
  };

  const session = new StaffJudgeSession(ctx, {
    workspaceRoot: '/tmp/zhiban-test-workspace',
    timeoutMs: 1_000,
  });

  const first = session.ask('第一条');
  const second = session.ask('第二条');
  await assert.rejects(second, /JUDGE_BUSY/);
  assert.equal(await first, '{"violation":true}');
  // 忙时不再排队，只有第一条真的发出去；告警不会因此延迟几分钟
  assert.deepEqual(prompts, ['第一条']);
  for (const resolve of resolvers) resolve();

  // 前一条结束后可以继续用
  assert.equal(await session.ask('第三条'), '{"violation":true}');
});

// ---------- 两层质检：关键词初筛 + 语义复核 ----------

function recorder() {
  const alerts: string[] = [];
  const dismissed: string[][] = [];
  return {
    alerts,
    dismissed,
    raiseAlert: () => {
      alerts.push('alert');
    },
    dismiss: (ruleIds: string[]) => {
      dismissed.push(ruleIds);
    },
  };
}

test('两层质检：没有可疑词不进模型，也不留痕', async () => {
  const r = recorder();
  let judged = 0;
  const outcome = await decideStaffQuality(
    { text: '早上好，今天血糖怎么样？' },
    {
      precheck: () => ({ hits: [], hitNames: [] }),
      judge: () => {
        judged += 1;
        return Promise.resolve('violation');
      },
      raiseAlert: r.raiseAlert,
      dismiss: r.dismiss,
    },
  );
  assert.equal(outcome, 'clean');
  assert.equal(judged, 0);
  assert.deepEqual(r.alerts, []);
  assert.deepEqual(r.dismissed, []);
});

test('两层质检：命中且模型判合规，只留痕不告警', async () => {
  const r = recorder();
  const judged: Array<{ text: string; ruleNames: string[] }> = [];
  const outcome = await decideStaffQuality(
    { text: '这不算诊断，只是提醒您去复查。' },
    {
      precheck: () => ({ hits: ['rul_builtin_no_diagnosis'], hitNames: ['不诊断'] }),
      judge: (input) => {
        judged.push(input);
        return Promise.resolve('ok');
      },
      raiseAlert: r.raiseAlert,
      dismiss: r.dismiss,
    },
  );
  assert.equal(outcome, 'dismissed');
  assert.equal(judged.length, 1);
  assert.deepEqual(judged[0]!.ruleNames, ['不诊断']);
  assert.deepEqual(r.alerts, []);
  assert.deepEqual(r.dismissed, [['rul_builtin_no_diagnosis']]);
});

test('两层质检：模型判违规、返回 unknown、抛错、未接入，都按保守策略告警', async () => {
  const pre = () => ({ hits: ['rul_builtin_no_diagnosis'], hitNames: ['不诊断'] });

  for (const judge of [
    () => Promise.resolve('violation' as const),
    () => Promise.resolve('unknown' as const),
    () => Promise.reject(new Error('MODEL_DOWN')),
  ]) {
    const r = recorder();
    const outcome = await decideStaffQuality(
      { text: '你就是糖尿病。' },
      { precheck: pre, judge, raiseAlert: r.raiseAlert, dismiss: r.dismiss },
    );
    assert.equal(outcome, 'alerted');
    assert.deepEqual(r.alerts, ['alert']);
    assert.deepEqual(r.dismissed, []);
  }

  // 患者域没装（没有 judge）时退回纯关键词告警
  const r = recorder();
  assert.equal(
    await decideStaffQuality(
      { text: '你就是糖尿病。' },
      { precheck: pre, raiseAlert: r.raiseAlert, dismiss: r.dismiss },
    ),
    'alerted',
  );
  assert.deepEqual(r.alerts, ['alert']);
});

test('两层质检：guard 没有初筛接口或初筛异常时，直接走原告警链路', async () => {
  const r = recorder();
  assert.equal(
    await decideStaffQuality({ text: '你就是糖尿病。' }, { raiseAlert: r.raiseAlert }),
    'alerted',
  );

  const r2 = recorder();
  assert.equal(
    await decideStaffQuality(
      { text: '你就是糖尿病。' },
      {
        precheck: () => {
          throw new Error('GUARD_BROKEN');
        },
        raiseAlert: r2.raiseAlert,
      },
    ),
    'alerted',
  );
  assert.deepEqual(r2.alerts, ['alert']);
});

test('两层质检：留痕失败不影响「判为合规」的结论', async () => {
  const r = recorder();
  const outcome = await decideStaffQuality(
    { text: '这不算诊断。' },
    {
      precheck: () => ({ hits: ['rul_builtin_no_diagnosis'], hitNames: ['不诊断'] }),
      judge: () => Promise.resolve('ok'),
      raiseAlert: r.raiseAlert,
      dismiss: () => {
        throw new Error('AUDIT_DOWN');
      },
    },
  );
  assert.equal(outcome, 'dismissed');
  assert.deepEqual(r.alerts, []);
});

test('语义复核会话：中间态不当作结论，turn/end 才取本回合最后一条文本', async () => {
  const listeners: Array<(...args: unknown[]) => void> = [];
  const ctx = {
    sessionController: {
      prompt: () => Promise.resolve(),
      resolveAgent: () => Promise.resolve({ error: 'NOT_FOUND' }),
      create: () => Promise.resolve({ sessionId: 'zhiban-guard-review' }),
    } as never,
    on: (_event: string, handler: (...args: unknown[]) => void) => {
      listeners.push(handler);
      return undefined;
    },
  };
  const session = new StaffJudgeSession(ctx, {
    workspaceRoot: '/tmp/zhiban-test-workspace',
    timeoutMs: 1_000,
  });

  const ask = session.ask('判断这句话');
  // 等会话就绪并完成订阅
  for (let i = 0; i < 50 && listeners.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(listeners.length, 1);

  const dispatch = (event: unknown): void => {
    for (const listener of listeners) {
      listener({ header: { id: 'zhiban-guard-review' } }, event);
    }
  };
  const message = (text: string) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  });

  dispatch({ type: 'turn/start' });
  dispatch(message('我先看一下。'));
  let settled = false;
  void ask.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '中间态不该当成结论');

  dispatch({ type: 'turn/end' });
  assert.equal(await ask, '我先看一下。');
});

test('语义复核会话：本回合没有文本时立即失败，不等到超时', async () => {
  const listeners: Array<(...args: unknown[]) => void> = [];
  const ctx = {
    sessionController: {
      prompt: () => Promise.resolve(),
      resolveAgent: () => Promise.resolve({ error: 'NOT_FOUND' }),
      create: () => Promise.resolve({ sessionId: 'zhiban-guard-review' }),
    } as never,
    on: (_event: string, handler: (...args: unknown[]) => void) => {
      listeners.push(handler);
      return undefined;
    },
  };
  const session = new StaffJudgeSession(ctx, {
    workspaceRoot: '/tmp/zhiban-test-workspace',
    timeoutMs: 5_000,
  });

  const ask = session.ask('判断这句话');
  for (let i = 0; i < 50 && listeners.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  for (const listener of listeners) {
    listener({ header: { id: 'zhiban-guard-review' } }, { type: 'turn/start' });
    listener({ header: { id: 'zhiban-guard-review' } }, { type: 'turn/end' });
  }
  await assert.rejects(ask, /JUDGE_EMPTY/);
});
