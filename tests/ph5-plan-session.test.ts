/**
 * PH5-04 生成会话适配：工具回传、超时、未调用工具的处理。
 * 用假 sessionController，不启动 DSH。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildPlanTool, DshPlanSessionPort } from '../plugins/zhiban-patient-h5/plan-session.ts';
import type { PlanSessionControllerLike } from '../plugins/zhiban-patient-h5/plan-session.ts';

const VALID = {
  stageGoal: '把三餐吃规律',
  foodTherapyRationale: '先从规律三餐开始',
  focusPoints: ['三餐按时', '晚餐不过饱'],
  actions: [
    {
      title: '早餐记录',
      purpose: '看看早餐够不够丰富',
      method: '拍照记录',
      schedule: { kind: 'daily', time: '07:30' },
      feedbackKind: 'record_meal',
    },
  ],
};

async function setup(options: { onPrompt?: (sessionId: string) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhiban-plan-test-'));
  const created: string[] = [];
  const prompted: string[] = [];
  const controller: PlanSessionControllerLike = {
    async create(request) {
      created.push(request.sessionId ?? 'new');
      return { sessionId: request.sessionId ?? 'new' };
    },
    async resolveAgent() {
      return { error: 'not found' };
    },
    async prompt(request) {
      prompted.push(request.sessionId);
      options.onPrompt?.(request.sessionId);
      return undefined;
    },
  };
  const port = new DshPlanSessionPort({ sessionController: controller, workspaceRoot: root });
  return { root, port, created, prompted };
}

test('模型调用工具后，生成端口拿到结构化草稿', async () => {
  const { port, prompted } = await setup({
    onPrompt: (sessionId) => {
      // 模拟模型在同一回合里调用工具
      port.acceptToolCall(sessionId, VALID);
    },
  });
  const result = await port.runTurn({
    patientId: 'pat_a',
    systemPrompt: 'sys',
    userPrompt: 'user',
    timeoutMs: 3000,
  });
  assert.deepEqual(result.toolArgs, VALID);
  assert.deepEqual(prompted, ['zhiban-plan-pat_a']);
});

test('模型没有调用工具时返回 NO_DRAFT，不把空结果当成功', async () => {
  const { port } = await setup();
  const result = await port.runTurn({
    patientId: 'pat_a',
    systemPrompt: 'sys',
    userPrompt: 'user',
    timeoutMs: 3000,
  });
  assert.equal(result.error, 'NO_DRAFT');
});

test('会话按患者隔离，同一患者复用同一会话名', async () => {
  const { port, prompted } = await setup();
  await port.runTurn({ patientId: 'pat_a', systemPrompt: 's', userPrompt: 'u', timeoutMs: 2000 });
  await port.runTurn({ patientId: 'pat_b', systemPrompt: 's', userPrompt: 'u', timeoutMs: 2000 });
  assert.deepEqual(prompted, ['zhiban-plan-pat_a', 'zhiban-plan-pat_b']);
});

test('工具在没有等待中的生成时不接受参数（防止误写）', async () => {
  const { port } = await setup();
  const tool = buildPlanTool(port);
  const result = (await tool.execute(VALID, { agent: { id: 'other-session' } })) as {
    accepted: boolean;
  };
  assert.equal(result.accepted, false);
  assert.equal(tool.name, 'submit_health_plan');
  assert.ok(JSON.stringify(tool.parameters).includes('feedbackKind'));
});
