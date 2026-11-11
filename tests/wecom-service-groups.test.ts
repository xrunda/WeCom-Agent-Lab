import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import {
  ServiceGroupRegistry,
  type ServiceRosterSnapshot,
} from '../plugins/zhiban-wecom/service-groups.ts';

function build(seed: string[], snapshot?: unknown) {
  const clock = new FakeClock(1_700_000_000_000);
  const saved: ServiceRosterSnapshot[] = [];
  const registry = new ServiceGroupRegistry({
    seedRoomIds: seed,
    snapshot,
    now: () => clock.now(),
    save: (value) => saved.push(value),
  });
  return { registry, saved, clock };
}

test('profile 白名单是初始种子：允许拉取且视为已发现', () => {
  const { registry } = build(['wrA', 'wrB']);
  assert.deepEqual(registry.roomIds(), ['wrA', 'wrB']);
  assert.equal(registry.isAllowed('wrA'), true);
  assert.equal(registry.isKnown('wrA'), true);
  assert.equal(registry.isAllowed('wrC'), false);
});

test('发现候选：只登记未知群，重复扫描不重复登记', () => {
  const { registry, saved } = build(['wrA']);
  const added = registry.markCandidates(['wrB', 'wrA', 'wrB', '']);
  assert.deepEqual(added, ['wrB']);
  assert.equal(registry.isKnown('wrB'), true);
  assert.equal(registry.isAllowed('wrB'), false);
  assert.equal(registry.stateOf('wrB'), 'candidate');
  assert.deepEqual(registry.candidateRoomIds(), ['wrB']);
  assert.equal(saved.length, 1);

  const again = registry.markCandidates(['wrB']);
  assert.deepEqual(again, []);
  assert.equal(saved.length, 1);
});

test('开始服务：加入白名单，重启后仍然生效', () => {
  const { registry, saved } = build(['wrA']);
  registry.markCandidates(['wrB']);
  registry.activate('wrB');

  assert.equal(registry.isAllowed('wrB'), true);
  assert.deepEqual(registry.roomIds(), ['wrA', 'wrB']);
  assert.equal(registry.stateOf('wrB'), 'active');
  assert.deepEqual(registry.candidateRoomIds(), []);

  const snapshot = saved.at(-1)!;
  const { registry: reloaded } = build(['wrA'], snapshot);
  assert.equal(reloaded.isAllowed('wrB'), true);
  assert.deepEqual(reloaded.roomIds(), ['wrA', 'wrB']);
});

test('移出服务：denied 优先于 profile 种子，重启不会被重新加回', () => {
  const { registry, saved } = build(['wrA', 'wrB']);
  registry.deactivate('wrA');

  assert.equal(registry.isAllowed('wrA'), false);
  assert.deepEqual(registry.roomIds(), ['wrB']);
  assert.equal(registry.stateOf('wrA'), 'inactive');
  assert.equal(registry.isKnown('wrA'), true);

  const { registry: reloaded } = build(['wrA', 'wrB'], saved.at(-1));
  assert.equal(reloaded.isAllowed('wrA'), false);
  assert.deepEqual(reloaded.roomIds(), ['wrB']);

  // 再次开始服务会清掉 denied
  reloaded.activate('wrA');
  assert.equal(reloaded.isAllowed('wrA'), true);
  assert.deepEqual(reloaded.roomIds(), ['wrA', 'wrB']);
});

test('停用的候选不会被重新发现', () => {
  const { registry } = build(['wrA']);
  registry.markCandidates(['wrB']);
  registry.deactivate('wrB');

  assert.equal(registry.isKnown('wrB'), true);
  assert.deepEqual(registry.markCandidates(['wrB']), []);
  assert.deepEqual(registry.candidateRoomIds(), []);
});

test('损坏或旧版本的名单快照被忽略，按种子重建', () => {
  for (const snapshot of [null, 'broken', { version: 9 }, { version: 1, allowed: 'x' }]) {
    const { registry } = build(['wrA'], snapshot);
    assert.deepEqual(registry.roomIds(), ['wrA']);
  }
});

test('entries 同时包含种子与服务中 / 已发现的群，状态可读', () => {
  const { registry } = build(['wrA']);
  registry.markCandidates(['wrB']);
  registry.activate('wrC');
  const states = new Map(registry.entries().map((entry) => [entry.roomId, entry.state]));
  assert.equal(states.get('wrA'), 'active');
  assert.equal(states.get('wrB'), 'candidate');
  assert.equal(states.get('wrC'), 'active');
});
