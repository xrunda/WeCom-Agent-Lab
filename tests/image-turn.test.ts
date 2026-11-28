import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observeServiceGroup, setupRuntime } from './p1-helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function imageMessage(path: string, msgtime = 1_700_000_000_000, msgid = 'm_img_1') {
  return {
    msgid,
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '',
    msgtime,
    msgtype: 'image',
    mediaPath: path,
  };
}

async function withImage(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-image-turn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'meal.jpg');
  await writeFile(path, JPEG);
  return path;
}

function imageParts(content: Array<{ type: string }>) {
  return content.filter((part) => part.type === 'image');
}

test('#55 餐食图：注入图片附件、写入饮食记录，草稿保留低风险', async (t) => {
  const path = await withImage(t);
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });

  h.sessions.onPrompt = async (sessionId) => {
    h.runtime.imageClassify(sessionId, { kind: 'meal', confidence: 0.9 });
    h.runtime.mealLogWrite(sessionId, {
      foods: [
        { name: '清蒸鲈鱼', portion: '约 150g' },
        { name: '米饭', portion: '一小碗' },
      ],
      mealType: 'dinner',
      confidence: 0.9,
    });
    await h.runtime.replyDraft(sessionId, {
      body: '晚餐搭配不错，蛋白质和主食都有；酱汁少一点会更清爽。',
      inboundSummary: '患者发来一张晚餐照片',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound(imageMessage(path));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.sessions.prompts.length, 1);
  const prompt = h.sessions.prompts[0]!;
  assert.match(prompt.text, /【本轮图片】/);
  assert.match(prompt.text, /image_classify/);
  const parts = imageParts(prompt.content);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, 'image');

  assert.equal(h.bridge.enqueued.length, 1);
  const draft = h.bridge.enqueued[0]!;
  assert.equal(draft.riskLevel, 'low');
  assert.deepEqual(draft.mediaIds, [path]);
  assert.deepEqual(draft.mediaKinds, ['meal']);
  assert.equal(draft.fallback, false);

  const patient = h.store.findPatientByExternalId('wm_patient');
  assert.ok(patient);
  const logs = h.store.listMealLogs(patient.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.mealType, 'dinner');
  assert.deepEqual(logs[0]!.foods[0], { name: '清蒸鲈鱼', portion: '约 150g' });
  assert.equal(logs[0]!.mediaPath, path);

  const mealEvent = h.events.find((event) => event.type === 'patient.meal.logged');
  assert.ok(mealEvent);
  assert.equal((mealEvent.data as { mealType: string }).mealType, 'dinner');
});

test('#55 一轮多图（煎饼 + 可乐）：同一条饮食记录关联全部原图，不丢图', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-image-turn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const meal = join(dir, 'pancake.jpg');
  const drink = join(dir, 'cola.jpg');
  await writeFile(meal, JPEG);
  await writeFile(drink, JPEG);

  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });

  h.sessions.onPrompt = async (sessionId) => {
    h.runtime.imageClassify(sessionId, { kind: 'meal', confidence: 0.85 });
    h.runtime.imageClassify(sessionId, { kind: 'meal', confidence: 0.85 });
    h.runtime.mealLogWrite(sessionId, {
      foods: [
        { name: '煎饼', portion: '1 份' },
        { name: '无糖可乐', portion: '1 瓶，约 500ml' },
      ],
      mealType: 'breakfast',
      confidence: 0.85,
    });
    await h.runtime.replyDraft(sessionId, {
      body: '早餐看到了：煎饼配无糖可乐，已经记进饮食记录。',
      inboundSummary: '患者发来煎饼和可乐两张照片',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound(imageMessage(meal, 1_700_000_000_000, 'm_img_1'));
  h.runtime.routeInbound(imageMessage(drink, 1_700_000_000_000, 'm_img_2'));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.sessions.prompts.length, 1);
  assert.equal(imageParts(h.sessions.prompts[0]!.content).length, 2);

  const patient = h.store.findPatientByExternalId('wm_patient');
  assert.ok(patient);
  const logs = h.store.listMealLogs(patient.id);
  assert.equal(logs.length, 1);
  // 两张原图都挂在同一条记录上；mediaPath 保留首张兼容旧读取逻辑
  assert.equal(logs[0]!.mediaPath, meal);
  assert.deepEqual(logs[0]!.mediaPaths, [meal, drink]);
});

test('#55 化验单图：不写饮食记录时风险至少 medium', async (t) => {
  const path = await withImage(t);
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });

  h.sessions.onPrompt = async (sessionId) => {
    h.runtime.imageClassify(sessionId, { kind: 'report', confidence: 0.95 });
    await h.runtime.replyDraft(sessionId, {
      body: '报告已收到，我请顾问看过后回复您。',
      inboundSummary: '患者发来一张化验单',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound(imageMessage(path));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued[0]!.riskLevel, 'medium');
  assert.deepEqual(h.bridge.enqueued[0]!.mediaKinds, ['report']);
});

test('#55 餐食图但模型未写饮食记录：风险同样抬到 medium', async (t) => {
  const path = await withImage(t);
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });

  h.sessions.onPrompt = async (sessionId) => {
    h.runtime.imageClassify(sessionId, { kind: 'meal', confidence: 0.5 });
    await h.runtime.replyDraft(sessionId, {
      body: '图上看起来是清蒸鱼和米饭，对吗？',
      inboundSummary: '患者发来一张餐食照片',
      riskLevel: 'low',
      citedMemoryIds: [],
      citedKnowledgeIds: [],
    });
  };

  h.runtime.routeInbound(imageMessage(path));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued[0]!.riskLevel, 'medium');
  assert.deepEqual(h.bridge.enqueued[0]!.mediaKinds, ['meal']);
});

test('#55 图片读不到时降级为纯文字回合，不中断', async (t) => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.onPrompt = async (sessionId) => {
    await h.runtime.replySkip(sessionId, { reason: '图片不可读' });
  };

  h.runtime.routeInbound(imageMessage('/tmp/does-not-exist/zhiban.jpg'));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.sessions.prompts.length, 1);
  assert.equal(imageParts(h.sessions.prompts[0]!.content).length, 0);
  assert.deepEqual(h.bridge.enqueued, []);
  const skipped = h.events.find((event) => event.type === 'patient.image.skipped');
  assert.ok(skipped);
  assert.equal((skipped.data as { failed: number }).failed, 1);
});

test('#55 图片回合模型失败：模板正文用「收到您的照片」，风险 medium', async (t) => {
  const path = await withImage(t);
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  h.sessions.failPrompt = true;

  h.runtime.routeInbound(imageMessage(path));
  h.clock.advance(30_000);
  await h.runtime.flushDue();

  assert.equal(h.bridge.enqueued.length, 1);
  const draft = h.bridge.enqueued[0]!;
  assert.equal(draft.fallback, true);
  assert.match(draft.body, /^收到您的照片，.+顾问稍后为您详细回复。$/);
  assert.equal(draft.body.endsWith('顾问稍后为您详细回复。'), true);
  assert.equal(draft.riskLevel, 'medium');
  assert.deepEqual(draft.mediaKinds, ['image']);
});

test('#55 没有图片的回合不能调用 meal_log_write', () => {
  const h = setupRuntime();
  observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  assert.throws(
    () =>
      h.runtime.mealLogWrite('session_missing', {
        foods: [{ name: '米饭' }],
        mealType: 'lunch',
        confidence: 0.8,
      }),
    /NO_ACTIVE_TURN/,
  );
});
