import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import { GroupInfoClient } from '../plugins/zhiban-wecom/group-info.ts';

const CORP_ID = 'corp_test';
const CONTACT_SECRET = 'contact-secret-should-never-appear';
const NICKNAME = '张女士';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

interface Recorder {
  fetchImpl: typeof fetch;
  urls: string[];
  groupCalls: number;
}

function recorder(groupResponse: unknown): Recorder {
  const urls: string[] = [];
  const state = { groupCalls: 0 };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/gettoken')) {
      return jsonResponse({ errcode: 0, access_token: 'token_test', expires_in: 7200 });
    }
    state.groupCalls += 1;
    return jsonResponse(groupResponse);
  }) as typeof fetch;
  return {
    fetchImpl,
    urls,
    get groupCalls() {
      return state.groupCalls;
    },
  };
}

function client(
  fetchImpl: typeof fetch,
  clock: FakeClock,
  options: { corpId?: string; contactSecret?: string; logger?: (line: string) => void } = {},
): GroupInfoClient {
  return new GroupInfoClient({
    corpId: options.corpId ?? CORP_ID,
    contactSecret: options.contactSecret ?? CONTACT_SECRET,
    clock,
    fetchImpl,
    logger: options.logger,
  });
}

test('正常返回时按 userid 映射群昵称，token 与群结果都缓存', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  const rec = recorder({
    errcode: 0,
    group_chat: {
      name: '客户-张女士',
      member_list: [
        { userid: 'wm_zhang', type: 2, name: NICKNAME },
        { userid: 'LiGuang', type: 1, name: '李光' },
        // 没有昵称的成员不写映射，调用方回退 id 尾号
        { userid: 'wm_nickless', type: 2 },
      ],
    },
  });
  const info = client(rec.fetchImpl, clock, { logger: (line) => logs.push(line) });

  assert.equal(info.enabled, true);
  const names = await info.memberNames('wr_group_1');

  assert.equal(names?.get('wm_zhang'), NICKNAME);
  assert.equal(names?.get('LiGuang'), '李光');
  assert.equal(names?.get('wm_nickless'), undefined);

  // 群名与昵称来自同一次请求：roomInfo 命中缓存，群名可同步到患者域
  const room = await info.roomInfo('wr_group_1');
  assert.equal(room?.name, '客户-张女士');
  assert.equal(room?.names.get('wm_zhang'), NICKNAME);
  // type=2 是外部联系人；发现任务用它预填候选群成员
  assert.deepEqual(
    room?.members?.map((member) => [member.userId, member.isExternal]),
    [
      ['wm_zhang', true],
      ['LiGuang', false],
      ['wm_nickless', true],
    ],
  );

  // 缓存命中：不再打接口，token 也只取一次
  await info.memberNames('wr_group_1');
  assert.equal(rec.groupCalls, 1);
  assert.equal(rec.urls.filter((url) => url.includes('/gettoken')).length, 1);

  // 昵称不落日志
  assert.ok(!logs.join('\n').includes(NICKNAME), logs.join('\n'));
  assert.ok(!logs.join('\n').includes(CONTACT_SECRET), logs.join('\n'));
});

test('群名为空时返回 undefined，不覆盖已有名称', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const rec = recorder({
    errcode: 0,
    group_chat: {
      name: '   ',
      member_list: [{ userid: 'wm_zhang', type: 2, name: NICKNAME }],
    },
  });
  const info = client(rec.fetchImpl, clock);

  const room = await info.roomInfo('wr_group_1');
  assert.equal(room?.name, undefined);
  assert.equal(room?.names.get('wm_zhang'), NICKNAME);
});

test('90501 内部群回退 undefined，并做负缓存避免反复调用', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  const rec = recorder({ errcode: 90501, errmsg: 'chat is not external group chat' });
  const info = client(rec.fetchImpl, clock, { logger: (line) => logs.push(line) });

  assert.equal(await info.memberNames('wr_internal'), undefined);
  assert.equal(await info.memberNames('wr_internal'), undefined);
  assert.equal(rec.groupCalls, 1);
  assert.ok(logs.some((line) => line.includes('90501')));
  assert.ok(!logs.join('\n').includes(CONTACT_SECRET), logs.join('\n'));

  // 负缓存到期后重试
  clock.advance(10 * 60_000 + 1);
  assert.equal(await info.memberNames('wr_internal'), undefined);
  assert.equal(rec.groupCalls, 2);
});

test('缺 secret 或 corpId 时功能关闭，不发任何请求', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as typeof fetch;

  const noSecret = client(fetchImpl, clock, { contactSecret: '' });
  assert.equal(noSecret.enabled, false);
  assert.equal(await noSecret.memberNames('wr_group_1'), undefined);

  const noCorpId = client(fetchImpl, clock, { corpId: '' });
  assert.equal(noCorpId.enabled, false);
  assert.equal(await noCorpId.memberNames('wr_group_1'), undefined);

  assert.equal(calls, 0);
});

test('拿不到 access_token 时静默回退，错误信息不含 Secret，且退避重试', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  let tokenCalls = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes('/gettoken')) {
      tokenCalls += 1;
      return jsonResponse({ errcode: 40001, errmsg: 'invalid credential' });
    }
    throw new Error('不应调用群接口');
  }) as typeof fetch;
  const info = client(fetchImpl, clock, { logger: (line) => logs.push(line) });

  assert.equal(await info.memberNames('wr_group_1'), undefined);
  assert.equal(await info.memberNames('wr_group_1'), undefined);
  // 凭据错误时 10 分钟内不再取 token
  assert.equal(tokenCalls, 1);

  const output = logs.join('\n');
  assert.ok(output.includes('40001'), output);
  assert.ok(!output.includes(CONTACT_SECRET), output);

  clock.advance(10 * 60_000 + 1);
  assert.equal(await info.memberNames('wr_group_1'), undefined);
  assert.equal(tokenCalls, 2);
});

test('客户群列表按 cursor 翻页并去重，只返回定位信息', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const pages = [
    {
      errcode: 0,
      group_chat_list: [
        { chat_id: 'wrA', owner: 'LiGuang', status: 0, create_time: 1 },
        { chat_id: 'wrB', owner: 'LiGuang', status: 0, create_time: 2 },
      ],
      next_cursor: 'cursor_2',
    },
    {
      errcode: 0,
      group_chat_list: [
        { chat_id: 'wrB', owner: 'LiGuang', status: 0, create_time: 2 },
        { chat_id: 'wrC', status: 0 },
      ],
      next_cursor: '',
    },
  ];
  const listBodies: unknown[] = [];
  let listCalls = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes('/gettoken')) {
      return jsonResponse({ errcode: 0, access_token: 'token_test', expires_in: 7200 });
    }
    assert.ok(String(input).includes('/groupchat/list'));
    listBodies.push(JSON.parse(String(init?.body ?? '{}')));
    const page = pages[listCalls] ?? { errcode: 0, group_chat_list: [] };
    listCalls += 1;
    return jsonResponse(page);
  }) as typeof fetch;
  const info = client(fetchImpl, clock);

  const groups = await info.listCustomerGroups();

  assert.deepEqual(
    groups?.map((group) => group.chatId),
    ['wrA', 'wrB', 'wrC'],
  );
  assert.equal(listCalls, 2);
  assert.deepEqual(listBodies[0], { status_filter: 0, limit: 100 });
  assert.deepEqual(listBodies[1], { status_filter: 0, limit: 100, cursor: 'cursor_2' });
});

test('群主过滤通过 owner_filter 传给企微，而不是靠响应里的 owner 字段', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const listBodies: unknown[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes('/gettoken')) {
      return jsonResponse({ errcode: 0, access_token: 'token_test', expires_in: 7200 });
    }
    listBodies.push(JSON.parse(String(init?.body ?? '{}')));
    // 真机响应只有 chat_id / status，没有 owner
    return jsonResponse({ errcode: 0, group_chat_list: [{ chat_id: 'wrA', status: 0 }] });
  }) as typeof fetch;
  const info = client(fetchImpl, clock);

  const groups = await info.listCustomerGroups([' LiGuang ', '', 'Wang']);

  assert.deepEqual(
    groups?.map((group) => group.chatId),
    ['wrA'],
  );
  assert.deepEqual(listBodies[0], {
    status_filter: 0,
    limit: 100,
    owner_filter: { userid_list: ['LiGuang', 'Wang'] },
  });
});

test('客户群列表失败返回 undefined，只打 errcode', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes('/gettoken')) {
      return jsonResponse({ errcode: 0, access_token: 'token_test', expires_in: 7200 });
    }
    return jsonResponse({ errcode: 60020, errmsg: 'not allow to access from your ip' });
  }) as typeof fetch;
  const info = client(fetchImpl, clock, { logger: (line) => logs.push(line) });

  assert.equal(await info.listCustomerGroups(), undefined);
  assert.ok(logs.some((line) => line.includes('60020')));
  assert.ok(!logs.join('\n').includes(CONTACT_SECRET));
});
