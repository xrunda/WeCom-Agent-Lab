import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import { GroupDiscovery } from '../plugins/zhiban-wecom/group-discovery.ts';
import type { CustomerGroupSummary, RoomInfo } from '../plugins/zhiban-wecom/group-info.ts';
import { ServiceGroupRegistry } from '../plugins/zhiban-wecom/service-groups.ts';

const NICKNAME = '张女士';
const GROUP_NAME = '客户-张女士';

interface ObservedRoom {
  roomId: string;
  members: Array<{ id: string; isExternal: boolean; lastActiveAt: number; displayName?: string }>;
  groupName?: string;
  memberNames?: Record<string, string>;
}

function build(options: {
  seed?: string[];
  groups?: CustomerGroupSummary[] | undefined;
  infos?: Record<string, RoomInfo | undefined>;
  withPatient?: boolean;
  owners?: string[];
}) {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  const observed: ObservedRoom[] = [];
  const registry = new ServiceGroupRegistry({
    seedRoomIds: options.seed ?? [],
    now: () => clock.now(),
    save: () => undefined,
  });
  const client = {
    async listCustomerGroups() {
      return options.groups;
    },
    async roomInfo(roomId: string) {
      return options.infos?.[roomId];
    },
  };
  const discovery = new GroupDiscovery({
    client,
    registry,
    patient: () =>
      options.withPatient === false
        ? undefined
        : { observeRooms: (rooms) => observed.push(...rooms) },
    now: () => clock.now(),
    ownerUserIds: options.owners,
    logger: (line) => logs.push(line),
  });
  return { discovery, registry, observed, logs, clock };
}

test('只登记企业创建的客户群：新群成为候选并带群名/成员交给患者域', async () => {
  const { discovery, registry, observed } = build({
    groups: [{ chatId: 'wrNEW' }],
    infos: {
      wrNEW: {
        name: GROUP_NAME,
        names: new Map([['wmCUST', NICKNAME]]),
        members: [
          { userId: 'LiGuang', isExternal: false },
          { userId: 'wmCUST', isExternal: true, name: NICKNAME },
        ],
      },
    },
  });

  const result = await discovery.scanOnce();

  assert.deepEqual(result, { listed: 1, added: 1, refreshed: 1, skipped: 0 });
  assert.equal(registry.isKnown('wrNEW'), true);
  assert.equal(registry.isAllowed('wrNEW'), false);
  assert.equal(registry.stateOf('wrNEW'), 'candidate');
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.roomId, 'wrNEW');
  assert.equal(observed[0]!.groupName, GROUP_NAME);
  assert.deepEqual(observed[0]!.memberNames, { wmCUST: NICKNAME });
  assert.deepEqual(
    observed[0]!.members.map((member) => [member.id, member.isExternal]),
    [
      ['LiGuang', false],
      ['wmCUST', true],
    ],
  );
});

test('重复扫描不重复登记；候选会刷新群名与成员', async () => {
  const { discovery, registry, observed } = build({
    groups: [{ chatId: 'wrNEW' }],
    infos: { wrNEW: { names: new Map(), members: [] } },
  });
  await discovery.scanOnce();
  const second = await discovery.scanOnce();

  assert.equal(second.added, 0);
  assert.equal(second.refreshed, 1);
  assert.equal(observed.length, 2);
  assert.equal(registry.isKnown('wrNEW'), true);
});

test('已服务中 / 已停用 / 种子群不会被重新登记', async () => {
  const { discovery, registry, observed } = build({
    seed: ['wrSEED'],
    groups: [{ chatId: 'wrSEED' }, { chatId: 'wrACTIVE' }, { chatId: 'wrOFF' }],
  });
  registry.activate('wrACTIVE');
  registry.markCandidates(['wrOFF']);
  registry.deactivate('wrOFF');

  const result = await discovery.scanOnce();

  assert.equal(result.listed, 3);
  assert.equal(result.added, 0);
  // 服务中 / 停用 / 种子群都不再登记或刷新
  assert.deepEqual(observed, []);
});

test('客户群列表接口失败时静默跳过本轮', async () => {
  const { discovery, registry } = build({ groups: undefined });
  const result = await discovery.scanOnce();
  assert.deepEqual(result, { listed: 0, added: 0, refreshed: 0, skipped: 0 });
  assert.equal(registry.isKnown('wrNEW'), false);
});

test('单个群的详情查不到也先登记候选，空成员不阻塞', async () => {
  const { discovery, registry, observed } = build({
    groups: [{ chatId: 'wrNEW' }],
    infos: { wrNEW: undefined },
  });
  const result = await discovery.scanOnce();

  assert.equal(result.added, 1);
  assert.equal(registry.isKnown('wrNEW'), true);
  assert.deepEqual(observed[0], { roomId: 'wrNEW', members: [] });
});

test('患者域未就绪时保留候选，下轮会重试', async () => {
  const { discovery, registry, logs } = build({
    groups: [{ chatId: 'wrNEW' }],
    withPatient: false,
  });
  const result = await discovery.scanOnce();

  assert.equal(result.added, 1);
  assert.equal(result.refreshed, 0);
  assert.equal(registry.isKnown('wrNEW'), true);
  assert.ok(logs.some((line) => line.includes('患者域未就绪')));
});

test('配置群主后只登记本环境的群，其他环境的群不进候选', async () => {
  const { discovery, registry } = build({
    owners: ['LiGuang'],
    groups: [
      { chatId: 'wrMINE', owner: 'LiGuang' },
      { chatId: 'wrOTHER_ENV', owner: 'DevAdvisor' },
      { chatId: 'wrNO_OWNER' },
    ],
    infos: {},
  });

  const result = await discovery.scanOnce();

  assert.equal(result.listed, 1);
  assert.equal(result.added, 1);
  assert.equal(registry.isKnown('wrMINE'), true);
  assert.equal(registry.isKnown('wrOTHER_ENV'), false);
  // 群主缺失时无法确认归属，宁可不登记
  assert.equal(registry.isKnown('wrNO_OWNER'), false);
});

test('日志只含数量与群尾号，不含群名或昵称', async () => {
  const { discovery, logs } = build({
    groups: [{ chatId: 'wrNEWABCDEF' }],
    infos: {
      wrNEWABCDEF: {
        name: GROUP_NAME,
        names: new Map([['wmCUST', NICKNAME]]),
        members: [{ userId: 'wmCUST', isExternal: true, name: NICKNAME }],
      },
    },
  });
  await discovery.scanOnce();

  const joined = logs.join('\n');
  assert.ok(joined.includes('服务群发现'));
  assert.equal(joined.includes(GROUP_NAME), false);
  assert.equal(joined.includes(NICKNAME), false);
});
