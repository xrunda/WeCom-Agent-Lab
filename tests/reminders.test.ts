import test from 'node:test';
import assert from 'node:assert/strict';

import { ReminderThrottle } from '../src/c2/reminders.ts';

const NOW = 1_700_000_000_000;

test('同一 key 在窗口内只放行一次，到点后再放行', () => {
  const throttle = new ReminderThrottle(30 * 60_000);
  assert.equal(throttle.allow('draft_1', NOW), true);
  assert.equal(throttle.allow('draft_1', NOW + 60_000), false);
  assert.equal(throttle.allow('draft_1', NOW + 30 * 60_000 - 1), false);
  assert.equal(throttle.allow('draft_1', NOW + 30 * 60_000), true);
});

test('不同 key 各占各的窗口', () => {
  const throttle = new ReminderThrottle(30 * 60_000);
  assert.equal(throttle.allow('draft_1', NOW), true);
  assert.equal(throttle.allow('draft_2', NOW), true);
});

test('发送失败可以回退，下一次仍然提醒', () => {
  const throttle = new ReminderThrottle(30 * 60_000);
  assert.equal(throttle.allow('draft_1', NOW), true);
  throttle.release('draft_1');
  assert.equal(throttle.allow('draft_1', NOW + 1_000), true);
});
