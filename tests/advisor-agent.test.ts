/**
 * 顾问 Agent 回合编排（#167 §6 / §11）：串行、并发、限流、降级与补发。
 * 全部虚构数据，不依赖 DSH。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdvisorAgent } from '../plugins/zhiban-advisor/agent.ts';
import type {
  AdvisorTurnOutcome,
  AdvisorSessionPort,
} from '../plugins/zhiban-advisor/sessions.ts';
import type { AdvisorWecomDataPort } from '../src/p1/advisor/types.ts';

class FakeSessions implements AdvisorSessionPort {
  outcomes: AdvisorTurnOutcome[] = [];
  deferRun = false;
  releaseRun?: () => void;
  runTurnCalls = 0;
  /** 模拟工具在回合进行中写入数据（如饮食记录原图） */
  onRunTurn?: () => void;

  async ensure(advisorId: string) {
    return {
      advisorId,
      sessionId: `zhiban-advisor-${advisorId}`,
      workspacePath: '/tmp/zhiban-ws-advisor',
      createdAt: 0,
    };
  }

  async reset(advisorId: string) {
    return {
      advisorId,
      sessionId: `zhiban-advisor-${advisorId}-r1`,
      workspacePath: '/tmp/zhiban-ws-advisor-r',
      createdAt: 0,
    };
  }

  async runTurn(input: {
    sessionId: string;
    prompt: string;
    timeoutMs: number;
    onLateComplete?: (text: string) => void;
  }): Promise<AdvisorTurnOutcome> {
    this.runTurnCalls += 1;
    this.onRunTurn?.();
    if (this.deferRun) {
      await new Promise<void>((resolve) => {
        this.releaseRun = resolve;
      });
      return { status: 'completed', text: '结果' };
    }
    const outcome = this.outcomes.shift() ?? { status: 'empty' };
    if (outcome.status === 'timeout') {
      setTimeout(() => input.onLateComplete?.(outcome.text ?? '补发内容'), 5);
      return { status: 'timeout', text: outcome.text };
    }
    return outcome;
  }
}

class FakeData implements AdvisorWecomDataPort {
  sends: Array<{ advisorId: string; text: string }> = [];
  images: Array<{ advisorId: string; path: string }> = [];
  failImages = false;
  /** 模拟标注文字发送失败：第一次 sendText 返回 false */
  failLabelSend = false;
  canReadPatient = true as const;

  advisorName(advisorId: string): string | undefined {
    return `顾问${advisorId}`;
  }

  draftsFor() {
    return [];
  }

  promisesFor() {
    return [];
  }

  alertsFor() {
    return [];
  }

  pendingRepliesFor?() {
    return undefined;
  }

  activeDraftFor() {
    return undefined;
  }

  async sendText(advisorId: string, text: string): Promise<boolean> {
    if (this.failLabelSend && text.startsWith('【')) {
      this.failLabelSend = false;
      this.sends.push({ advisorId, text });
      return false;
    }
    this.sends.push({ advisorId, text });
    return true;
  }

  async sendImage(advisorId: string, path: string): Promise<boolean> {
    if (this.failImages) throw new Error('SEND_IMAGE_TOO_LARGE');
    this.images.push({ advisorId, path });
    return true;
  }
}

function setup(options: {
  maxConcurrentTurns?: number;
  messagesPerMinute?: number;
  messagesPerDay?: number;
  concurrencyWaitMs?: number;
} = {}) {
  const sessions = new FakeSessions();
  const data = new FakeData();
  const events: Array<{ type: string }> = [];
  const agent = new AdvisorAgent({
    sessions,
    data,
    emit: (type) => {
      events.push({ type });
    },
    now: () => 1_700_000_000_000,
    turnTimeoutMs: 30_000,
    maxConcurrentTurns: options.maxConcurrentTurns ?? 2,
    messagesPerMinute: options.messagesPerMinute ?? 20,
    messagesPerDay: options.messagesPerDay ?? 500,
    concurrencyWaitMs: options.concurrencyWaitMs ?? 5_000,
  });
  return { sessions, data, events, agent };
}

test('回合完成：把助手文本拆条发送给顾问本人', async () => {
  const { sessions, data, agent } = setup();
  sessions.outcomes.push({ status: 'completed', text: '汪女士最近血糖 5.8。' });
  const started = await agent.handle('adv_1', '汪女士血糖怎么样');
  assert.equal(started, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(data.sends.length, 1);
  assert.equal(data.sends[0]!.advisorId, 'adv_1');
  assert.match(data.sends[0]!.text, /5\.8/);
});

test('回合超时：先回「还在处理」，完成后补发带前缀', async () => {
  const { sessions, data, agent } = setup();
  sessions.outcomes.push({ status: 'timeout' });
  await agent.handle('adv_1', '这个问题要查很久');
  assert.match(data.sends[0]!.text, /要久一点/);
  // 等待补发
  await new Promise((resolve) => setTimeout(resolve, 20));
  const late = data.sends.find((send) => send.text.includes('补发内容'));
  assert.ok(late, '超时后完成应补发结果');
  assert.match(late!.text, /刚才那条查完了/);
});

test('回合没产出文本 → 如实说不编造', async () => {
  const { sessions, data, agent } = setup();
  sessions.outcomes.push({ status: 'empty' });
  await agent.handle('adv_1', '问一个查不到的问题');
  assert.match(data.sends[0]!.text, /没查到/);
});

test('模型报错 → 降级文案，只保留命令表动作', async () => {
  const { sessions, data, agent } = setup();
  sessions.outcomes.push({ status: 'error' });
  await agent.handle('adv_1', '问题');
  assert.match(data.sends[0]!.text, /我的待办/);
  assert.equal(data.sends[0]!.text.includes('话术'), false, '降级不列已退役关键词');
});

test('单顾问串行：进行中再发 → 上一条还在处理', async () => {
  const { sessions, data, agent } = setup();
  sessions.deferRun = true;
  const first = agent.handle('adv_1', '第一个问题');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await agent.handle('adv_1', '第二个问题');
  assert.equal(second, false);
  assert.match(data.sends[0]!.text, /还在处理/);
  sessions.releaseRun?.();
  await first;
});

test('每分钟限流：超过上限提示剩余秒数', async () => {
  const { sessions, data, agent } = setup({ messagesPerMinute: 2 });
  sessions.outcomes.push({ status: 'completed', text: 'a' });
  sessions.outcomes.push({ status: 'completed', text: 'b' });
  await agent.handle('adv_1', '1');
  await agent.handle('adv_1', '2');
  const limited = await agent.handle('adv_1', '3');
  assert.equal(limited, false);
  assert.match(data.sends[2]!.text, /请求太频繁/);
});

test('每日限流：超过后提示明天再试', async () => {
  const { sessions, data, agent } = setup({ messagesPerDay: 1 });
  sessions.outcomes.push({ status: 'completed', text: 'a' });
  await agent.handle('adv_1', '1');
  const limited = await agent.handle('adv_1', '2');
  assert.equal(limited, false);
  assert.match(data.sends[1]!.text, /今天/);
});

test('全局并发满：排队一小段后仍满则提示稍后', async () => {
  const { sessions, data, agent } = setup({ maxConcurrentTurns: 1, concurrencyWaitMs: 100 });
  sessions.deferRun = true;
  const first = agent.handle('adv_1', '第一个');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await agent.handle('adv_2', '第二个');
  assert.equal(second, false);
  assert.match(data.sends[0]!.text, /比较忙/);
  sessions.releaseRun?.();
  await first;
});

test('餐食原图：显式请求后，标注文字先发、原图后发，最多 3 张', async () => {
  const { sessions, data, agent } = setup();
  sessions.onRunTurn = () =>
    agent.recordMealMedia('adv_1', [
      { path: '/tmp/a.jpg', label: '11月16日 早餐 09:10 原图' },
      { path: '/tmp/b.png', label: '11月16日 午餐 12:20 原图' },
      { path: '/tmp/c.jpg', label: '11月16日 晚餐 18:30 原图' },
      { path: '/tmp/d.jpg', label: '11月16日 加餐 16:00 原图' },
    ]);
  sessions.outcomes.push({ status: 'completed', text: '这一天饮食记录如下。' });
  await agent.handle('adv_1', '查饮食记录');
  assert.equal(data.images.length, 3, '最多 3 张');
  assert.deepEqual(
    data.images.map((item) => item.path),
    ['/tmp/a.jpg', '/tmp/b.png', '/tmp/c.jpg'],
  );
  // 顺序：文字回复 → 每张图先标注再发图
  assert.equal(data.sends[0]!.text, '这一天饮食记录如下。', '先文字后图片');
  assert.match(data.sends[1]!.text, /【11月16日 早餐 09:10 原图】/, '每张图先发标注');
  assert.equal(data.sends[1]!.text.includes('早餐'), true);
  assert.equal(data.sends[2]!.text.includes('午餐'), true);
  assert.equal(data.sends[3]!.text.includes('晚餐'), true);
});

test('餐食原图：没有显式请求（未调用 recordMealMedia）就不发图', async () => {
  const { sessions, data, agent } = setup();
  sessions.outcomes.push({ status: 'completed', text: '这一天没有饮食记录。' });
  await agent.handle('adv_1', '查饮食记录');
  assert.equal(data.images.length, 0, '查记录不发图');
  assert.equal(data.sends.length, 1, '只发文字回复');
});

test('原图发送失败只跳过，不影响文字回复', async () => {
  const { sessions, data, agent } = setup();
  data.failImages = true;
  sessions.onRunTurn = () =>
    agent.recordMealMedia('adv_1', [{ path: '/tmp/a.jpg', label: '11月16日 早餐 原图' }]);
  sessions.outcomes.push({ status: 'completed', text: '文字照常发出。' });
  await agent.handle('adv_1', '查饮食记录');
  assert.equal(data.sends[0]!.text, '文字照常发出。');
  assert.equal(data.images.length, 0);
});

test('标注文字发送失败就不发这张图，避免无标注原图', async () => {
  const { sessions, data, agent } = setup();
  // 第一次 sendText 返回 false（模拟标注发送失败）
  data.failLabelSend = true;
  sessions.onRunTurn = () =>
    agent.recordMealMedia('adv_1', [
      { path: '/tmp/a.jpg', label: '11月16日 早餐 原图' },
      { path: '/tmp/b.jpg', label: '11月16日 午餐 原图' },
    ]);
  sessions.outcomes.push({ status: 'completed', text: '回复正文。' });
  await agent.handle('adv_1', '查饮食记录');
  // 第一张标注失败 → 第一张不发图；第二张标注成功 → 发图
  assert.equal(data.images.length, 1);
  assert.equal(data.images[0]!.path, '/tmp/b.jpg');
});

test('新一轮不补发上一轮残留的原图', async () => {
  const { sessions, data, agent } = setup();
  let first = true;
  sessions.onRunTurn = () => {
    if (first) {
      agent.recordMealMedia('adv_1', [{ path: '/tmp/a.jpg', label: '11月16日 早餐 原图' }]);
    }
    first = false;
  };
  sessions.outcomes.push({ status: 'completed', text: '第一轮。' });
  await agent.handle('adv_1', '第一问');
  // 第一轮已经补发过一次
  assert.equal(data.images.length, 1);
  sessions.outcomes.push({ status: 'completed', text: '第二轮。' });
  await agent.handle('adv_1', '第二问');
  assert.equal(data.images.length, 1, '第二轮没有新记录就不重复发图');
});
