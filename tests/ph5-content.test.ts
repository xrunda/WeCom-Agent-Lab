/**
 * PH5-08（#237）内容库：审核门禁、经典引用规则、下架行为、关联空态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/c2/memory.ts';
import { idFactory } from '../src/p1/ids.ts';
import {
  ContentError,
  ContentService,
  MemoryContentBackend,
  validateArticle,
} from '../src/p1/patient-h5-content.ts';

const NOW = Date.now();

function setup() {
  const clock = new FakeClock(NOW);
  const service = new ContentService({
    tenantId: 'tn_ct',
    backend: new MemoryContentBackend(),
    ids: idFactory(() => clock.now()),
    now: () => clock.now(),
  });
  return { clock, service };
}

const draft = {
  category: 'classics_life' as const,
  title: '从「五谷为养」读懂一日三餐',
  summary: '讲清主食与配菜的关系。',
  sections: [
    {
      kind: 'classic_quote' as const,
      text: '五谷为养，五果为助，五畜为益，五菜为充',
      citation: '《黄帝内经·素问·脏气法时论》',
      verified: true,
    },
    { kind: 'plain_explanation' as const, text: '主食养身，果菜相助。' },
  ],
  authorType: 'editor' as const,
  authorName: '编辑部',
  scenarioTags: ['breakfast', 'staple'],
  actorId: 'acc_1',
};

test('未审核内容对患者完全不可见；发布后才可见', async () => {
  const { service } = setup();
  const article = await service.create(draft);
  assert.equal(service.listPublished().length, 0);
  assert.throws(
    () => service.getPublished(article.id),
    (error: unknown) => error instanceof ContentError && error.code === 'NOT_FOUND',
  );

  await service.submitReview({ id: article.id, actorId: 'acc_1' });
  assert.equal(service.listPublished().length, 0, '待审核仍不可见');

  const published = await service.publish({
    id: article.id,
    reviewerAccountId: 'acc_2',
    reviewerName: '陈营养师（虚构）',
  });
  assert.equal(published.status, 'published');
  assert.equal(published.reviewedByName, '陈营养师（虚构）');
  assert.ok(published.reviewedAt);
  assert.equal(service.listPublished().length, 1);
});

test('草稿不能直接发布（必须经过审核状态）', async () => {
  const { service } = setup();
  const article = await service.create(draft);
  await assert.rejects(
    () => service.publish({ id: article.id, reviewerAccountId: 'a', reviewerName: 'b' }),
    (error: unknown) => error instanceof ContentError && error.code === 'CONFLICT',
  );
});

test('经典引用必须带出处并标注已核对', () => {
  const violations = validateArticle({
    ...draft,
    sections: [{ kind: 'classic_quote', text: '五谷为养' }],
  });
  assert.ok(violations.some((item) => item.includes('出处')));
  assert.ok(violations.some((item) => item.includes('逐字核对')));
});

test('白话与自拟文案不得署名古籍', () => {
  const violations = validateArticle({
    ...draft,
    sections: [
      draft.sections[0]!,
      { kind: 'plain_explanation', text: '我们建议这样吃', citation: '《黄帝内经》' },
    ],
  });
  assert.ok(violations.some((item) => item.includes('只有经典引用可以标注出处')));
});

test('疗效宣称被拒绝', () => {
  const violations = validateArticle({
    ...draft,
    sections: [
      draft.sections[0]!,
      { kind: 'practice', text: '这样吃可以降血糖' },
    ],
  });
  assert.ok(violations.some((item) => item.includes('疗效宣称')));
});

test('食材类必须写食用方式、适用条件与注意事项', () => {
  const violations = validateArticle({
    ...draft,
    category: 'ingredients',
    sections: [{ kind: 'modern_life', text: '山药很常见' }],
  });
  assert.ok(violations.some((item) => item.includes('食用方式')));
});

test('下架后列表与详情都不再返回；旧引用仍能追到版本号', async () => {
  const { service } = setup();
  const article = await service.create(draft);
  await service.submitReview({ id: article.id, actorId: 'acc_1' });
  await service.publish({ id: article.id, reviewerAccountId: 'acc_2', reviewerName: '审核人' });
  const reference = { articleId: article.id, version: article.version };

  await service.retire({ id: article.id, actorId: 'acc_2' });
  assert.equal(service.listPublished().length, 0, '下架后不再推荐');
  assert.throws(
    () => service.getPublished(article.id),
    (error: unknown) => error instanceof ContentError && error.code === 'NOT_FOUND',
  );
  // 团队侧仍可查到，引用可追溯
  const teamView = service.getForTeam(reference.articleId);
  assert.equal(teamView.status, 'retired');
  assert.equal(teamView.version, reference.version);
});

test('编辑已发布内容会版本 +1 并回到草稿，需要重新审核', async () => {
  const { service } = setup();
  const article = await service.create(draft);
  await service.submitReview({ id: article.id, actorId: 'acc_1' });
  await service.publish({ id: article.id, reviewerAccountId: 'acc_2', reviewerName: '审核人' });

  const edited = await service.update({
    id: article.id,
    actorId: 'acc_1',
    patch: { title: '换个标题' },
  });
  assert.equal(edited.version, article.version + 1);
  assert.equal(edited.status, 'draft');
  assert.equal(service.listPublished().length, 0, '改过的内容需要重新发布');
});

test('关联内容：只从已发布里选，无匹配就返回空，不凑数', async () => {
  const { service } = setup();
  const article = await service.create(draft);
  await service.submitReview({ id: article.id, actorId: 'acc_1' });
  await service.publish({ id: article.id, reviewerAccountId: 'acc_2', reviewerName: '审核人' });

  assert.equal(service.related({ tags: ['breakfast'] }).length, 1);
  assert.equal(service.related({ tags: ['sleep'] }).length, 0, '没有适配内容就返回空');
  assert.equal(service.related({ tags: [] }).length, 0, '没有场景标签不推荐');
});

test('下架内容不会再出现在关联推荐里', async () => {
  const { service } = setup();
  const article = await service.create(draft);
  await service.submitReview({ id: article.id, actorId: 'acc_1' });
  await service.publish({ id: article.id, reviewerAccountId: 'acc_2', reviewerName: '审核人' });
  assert.equal(service.related({ tags: ['breakfast'] }).length, 1);

  await service.retire({ id: article.id, actorId: 'acc_2' });
  assert.equal(service.related({ tags: ['breakfast'] }).length, 0);
});
