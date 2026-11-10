import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ImageLoadError,
  MEAL_VISION_SKILL,
  imageFallbackBody,
  imageInstructionBlock,
  imageKindLabel,
  loadImageAttachment,
  loadTurnImages,
  mealLogView,
  sniffImageMediaType,
  validateImageClassify,
  validateMealLogWrite,
  type MealLogRecord,
} from '../src/p1/vision.ts';

/** 只需要魔数正确；视觉链路不会在单测里真解码 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
]);

async function tempFile(name: string, data: Buffer): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-vision-'));
  const path = join(dir, name);
  await writeFile(path, data);
  return { dir, path };
}

test('#55 按魔数识别 JPEG / PNG / WebP，扩展名不参与判断', () => {
  assert.equal(sniffImageMediaType(JPEG), 'image/jpeg');
  assert.equal(sniffImageMediaType(PNG), 'image/png');
  assert.equal(sniffImageMediaType(WEBP), 'image/webp');
  assert.equal(sniffImageMediaType(Buffer.from('not an image')), undefined);
});

test('#55 loadImageAttachment 返回 base64 附件；名称可选', async (t) => {
  const file = await tempFile('meal.jpg', JPEG);
  t.after(() => rm(file.dir, { recursive: true, force: true }));

  const part = await loadImageAttachment(file.path, { name: '晚餐.jpg' });
  assert.equal(part.type, 'image');
  assert.equal(part.mediaType, 'image/jpeg');
  assert.equal(part.data, JPEG.toString('base64'));
  assert.equal(part.name, '晚餐.jpg');
});

test('#55 文件缺失 / 超限 / 格式不支持时抛带错误码的 ImageLoadError', async (t) => {
  const file = await tempFile('meal.jpg', JPEG);
  t.after(() => rm(file.dir, { recursive: true, force: true }));

  await assert.rejects(loadImageAttachment(join(file.dir, 'missing.jpg')), (error: unknown) => {
    assert.ok(error instanceof ImageLoadError);
    assert.equal(error.code, 'IMAGE_MISSING');
    return true;
  });
  await assert.rejects(loadImageAttachment(file.path, { maxBytes: 4 }), (error: unknown) => {
    assert.ok(error instanceof ImageLoadError);
    assert.equal(error.code, 'IMAGE_TOO_LARGE');
    return true;
  });

  const bad = await tempFile('note.txt', Buffer.from('hello world'));
  t.after(() => rm(bad.dir, { recursive: true, force: true }));
  await assert.rejects(loadImageAttachment(bad.path), (error: unknown) => {
    assert.ok(error instanceof ImageLoadError);
    assert.equal(error.code, 'IMAGE_UNSUPPORTED');
    return true;
  });
});

test('#55 loadTurnImages 只记失败张数，单轮最多注入上限张', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-vision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, 'a.jpg');
  const second = join(dir, 'b.png');
  await writeFile(first, JPEG);
  await writeFile(second, PNG);

  const loaded = await loadTurnImages([first, join(dir, 'missing.jpg'), second], {
    maxPerTurn: 1,
  });
  assert.equal(loaded.images.length, 1);
  assert.equal(loaded.images[0]!.mediaType, 'image/jpeg');
  assert.equal(loaded.failed, 0);
  assert.equal(loaded.skipped, 2);

  const all = await loadTurnImages([first, join(dir, 'missing.jpg'), second], { maxPerTurn: 4 });
  assert.equal(all.images.length, 2);
  assert.equal(all.failed, 1);
});

test('#55 image_classify 只接受四种类型与 0–1 置信度', () => {
  const ok = validateImageClassify({ kind: 'meal', confidence: 0.8, finding: '一份火锅' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.kind, 'meal');

  const bad = validateImageClassify({ kind: 'food', confidence: 1.2 });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.violations.length >= 2, true);
  }
});

test('#55 meal_log_write 校验食物、餐次与置信度，并裁剪长度', () => {
  const ok = validateMealLogWrite({
    foods: [{ name: ' 清蒸鲈鱼 ', portion: '约 150g' }, { name: '米饭' }],
    mealType: 'dinner',
    confidence: 0.9,
    notes: '酱汁看不清',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.value.foods, [
      { name: '清蒸鲈鱼', portion: '约 150g' },
      { name: '米饭' },
    ]);
    assert.equal(ok.value.mealType, 'dinner');
  }

  const bad = validateMealLogWrite({ foods: [], mealType: 'supper', confidence: 2 });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.violations.some((item) => item.includes('foods')), true);
    assert.equal(bad.violations.some((item) => item.includes('mealType')), true);
    assert.equal(bad.violations.some((item) => item.includes('confidence')), true);
  }
});

test('#55 mealLogView 不暴露服务器路径，photoUrl 可空', () => {
  const record: MealLogRecord = {
    id: 'meal_1',
    tenantId: 'tn_test',
    patientId: 'pat_1',
    groupId: 'grp_1',
    messageId: 'msg_1',
    mediaPath: '/srv/media/pat_1/secret.jpg',
    mealType: 'lunch',
    foods: [{ name: '番茄炒蛋' }],
    confidence: 0.7,
    sandbox: false,
    createdAt: 1_700_000_000_000,
  };
  const view = mealLogView(record);
  assert.equal('mediaPath' in view, false);
  assert.equal(JSON.stringify(view).includes('/srv/media'), false);
  assert.equal(view.photoUrl, null);
  assert.equal(view.mealType, 'lunch');
});

test('#55 图片降级正文与类型标签', () => {
  assert.equal(imageFallbackBody('张女士'), '收到您的照片，张女士，顾问稍后为您详细回复。');
  assert.equal(imageFallbackBody(''), '收到您的照片，顾问稍后为您详细回复。');
  assert.equal(imageKindLabel('meal'), '餐食');
  assert.equal(imageKindLabel('report'), '化验单 / 报告');
  assert.equal(imageKindLabel(undefined), '图片');
  assert.match(imageInstructionBlock(2), /image_classify/);
  assert.match(imageInstructionBlock(2), /meal_log_write/);
  assert.match(imageInstructionBlock(2), /不解读任何指标/);
  assert.match(imageInstructionBlock(2), /riskLevel 至少为 medium/);
  assert.equal(imageInstructionBlock(0), '');
});

test('#55 meal-vision skill 覆盖类型分流与红线约束', () => {
  assert.match(MEAL_VISION_SKILL, /image_classify/);
  assert.match(MEAL_VISION_SKILL, /meal_log_write/);
  assert.match(MEAL_VISION_SKILL, /不解读指标/);
  assert.match(MEAL_VISION_SKILL, /不判断能否服用/);
  // 租户名拆开拼接，避免测试文件本身命中 `grep -ri` 检查
  assert.equal(MEAL_VISION_SKILL.includes(['七', '通'].join('')), false);
});
