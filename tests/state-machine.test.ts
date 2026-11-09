import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTransition,
  canTransition,
  isTerminal,
  releasesQueue,
} from '../src/c2/state-machine.ts';
import { makeDraft } from './helpers.ts';

test('QUEUED 可以进入 PUSHED / FAILED / DEAD_LETTER', () => {
  assert.equal(canTransition('QUEUED', 'PUSHED'), true);
  assert.equal(canTransition('QUEUED', 'FAILED'), true);
  assert.equal(canTransition('QUEUED', 'DEAD_LETTER'), true);
  assert.equal(canTransition('QUEUED', 'ACKNOWLEDGED'), false);
});

test('PUSHED 覆盖员工确认后的所有结果', () => {
  for (const next of [
    'ACKNOWLEDGED',
    'SKIPPED',
    'VERIFIED',
    'EDIT_SENT',
    'MISROUTE_ALERT',
    'UNVERIFIED',
  ] as const) {
    assert.equal(canTransition('PUSHED', next), true, `PUSHED -> ${next}`);
  }
});

test('终态不可再转移', () => {
  for (const status of [
    'SKIPPED',
    'VERIFIED',
    'EDIT_SENT',
    'MISROUTE_ALERT',
    'UNVERIFIED',
    'DEAD_LETTER',
  ] as const) {
    assert.equal(isTerminal(status), true);
    assert.equal(canTransition(status, 'QUEUED'), false);
    assert.equal(canTransition(status, 'PUSHED'), false);
  }
});

test('非法转移抛出 ILLEGAL_TRANSITION', () => {
  const draft = makeDraft({ status: 'QUEUED' });
  assert.throws(() => applyTransition(draft, 'ACKNOWLEDGED'), /ILLEGAL_TRANSITION/);
  assert.equal(draft.status, 'QUEUED');
});

test('合法转移会修改草稿状态', () => {
  const draft = makeDraft({ status: 'QUEUED' });
  applyTransition(draft, 'PUSHED');
  assert.equal(draft.status, 'PUSHED');
  applyTransition(draft, 'ACKNOWLEDGED');
  assert.equal(draft.status, 'ACKNOWLEDGED');
});

test('员工已处理或草稿已死的状态会释放串行队列', () => {
  for (const status of [
    'ACKNOWLEDGED',
    'SKIPPED',
    'VERIFIED',
    'EDIT_SENT',
    'MISROUTE_ALERT',
    'UNVERIFIED',
    'DEAD_LETTER',
  ] as const) {
    assert.equal(releasesQueue(status), true, status);
  }
  for (const status of ['QUEUED', 'PUSHED', 'FAILED'] as const) {
    assert.equal(releasesQueue(status), false, status);
  }
});
