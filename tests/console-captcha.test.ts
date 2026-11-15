/**
 * #186 登录验证码服务单测：图片可解码、答案不出网、一次性、过期与发放限流。
 * 不测字形美观，只测能被浏览器显示的基本 PNG 结构。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPTCHA_TTL_MS, CaptchaService } from '../src/p1/captcha.ts';
import { ConsoleError } from '../src/p1/console-error.ts';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function decodeImage(image: string): Buffer {
  assert.ok(image.startsWith('data:image/png;base64,'));
  return Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
}

test('验证码：签发的是 132x44 的 PNG，响应里不含答案', () => {
  const service = new CaptchaService({ codeGenerator: () => '2468' });
  const challenge = service.issue('203.0.113.9');

  assert.notEqual(challenge.id, '');
  assert.equal(challenge.expiresIn, Math.floor(CAPTCHA_TTL_MS / 1000));

  const png = decodeImage(challenge.image);
  assert.deepEqual([...png.subarray(0, PNG_MAGIC.length)], PNG_MAGIC);
  // IHDR：宽高在签名之后的固定位置
  assert.equal(png.readUInt32BE(16), 132);
  assert.equal(png.readUInt32BE(20), 44);

  assert.equal(JSON.stringify(challenge).includes('2468'), false);
  assert.equal('answer' in (challenge as unknown as Record<string, unknown>), false);
});

test('验证码：一次有效，错一次即作废', () => {
  const service = new CaptchaService({ codeGenerator: () => '4321' });
  const first = service.issue('198.51.100.7');
  assert.equal(service.verify(first.id, '4321'), true);
  assert.equal(service.verify(first.id, '4321'), false);

  const second = service.issue('198.51.100.7');
  assert.equal(service.verify(second.id, '0000'), false);
  // 同一个 id 答错后不能用正确答案补救
  assert.equal(service.verify(second.id, '4321'), false);
});

test('验证码：过期后作废，未知 id 与非法输入一律拒绝', () => {
  let now = 1_000_000;
  const service = new CaptchaService({ now: () => now, codeGenerator: () => '1357' });

  const expired = service.issue('192.0.2.1');
  now += CAPTCHA_TTL_MS + 1;
  assert.equal(service.verify(expired.id, '1357'), false);

  const live = service.issue('192.0.2.1');
  assert.equal(service.verify('missing-id', '1357'), false);
  assert.equal(service.verify(undefined, '1357'), false);
  assert.equal(service.verify('', '1357'), false);
  assert.equal(service.verify(live.id, ' 1357 '), true);

  const numeric = service.issue('192.0.2.1');
  assert.equal(service.verify(numeric.id, 1357), false);
});

test('验证码：同一 IP 的发放频率受限，窗口过后恢复，其他 IP 不受影响', () => {
  let now = 0;
  const service = new CaptchaService({
    now: () => now,
    issueLimit: 2,
    issueWindowMs: 60_000,
    codeGenerator: () => '1111',
  });

  service.issue('198.51.100.20');
  service.issue('198.51.100.20');
  assert.throws(
    () => service.issue('198.51.100.20'),
    (error: unknown) => error instanceof ConsoleError && error.code === 'RATE_LIMITED',
  );

  // 另一个 IP 正常
  assert.ok(service.issue('198.51.100.21').id);

  now = 60_000;
  assert.ok(service.issue('198.51.100.20').id);
});

test('验证码：每次签发的 id 不同', () => {
  const service = new CaptchaService({ codeGenerator: () => '2468' });
  const ids = new Set([
    service.issue('198.51.100.30').id,
    service.issue('198.51.100.30').id,
    service.issue('198.51.100.30').id,
  ]);
  assert.equal(ids.size, 3);
});
