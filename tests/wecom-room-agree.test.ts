import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/c2/memory.ts';
import {
  RoomAgreeClient,
  consentFromAgreeStatus,
  parseArchiveConfig,
} from '../plugins/zhiban-wecom/room-agree.ts';

const CORP_ID = 'corp_test';
const ARCHIVE_SECRET = 'archive-secret-should-never-appear';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

interface Recorder {
  fetchImpl: typeof fetch;
  urls: string[];
  roomCalls: number;
  bodies: unknown[];
}

function recorder(responses: Array<() => unknown | Promise<unknown>>): Recorder {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let tokenCalls = 0;
  let roomIndex = 0;
  const state = { roomCalls: 0 };
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/gettoken')) {
      return jsonResponse({ errcode: 0, access_token: `token_${tokenCalls++}`, expires_in: 7200 });
    }
    state.roomCalls += 1;
    bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    const next = responses[Math.min(roomIndex, responses.length - 1)];
    roomIndex += 1;
    return jsonResponse(await next?.());
  }) as typeof fetch;
  return {
    fetchImpl,
    urls,
    bodies,
    get roomCalls() {
      return state.roomCalls;
    },
  };
}

function client(
  fetchImpl: typeof fetch,
  clock: FakeClock,
  options: { logger?: (line: string) => void; configPath?: string; readFile?: (path: string) => string } = {},
): RoomAgreeClient {
  return new RoomAgreeClient({
    corpId: CORP_ID,
    secret: ARCHIVE_SECRET,
    clock,
    fetchImpl,
    logger: options.logger,
    configPath: options.configPath,
    readFile: options.readFile,
  });
}

test('正常返回时映射同意状态，token 与群结果都缓存', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  const rec = recorder([
    () => ({
      errcode: 0,
      agreeinfo: [
        { agree_status: 'Agree', exteranalopenid: 'wm_star' },
        { agree_status: 'Disagree', exteranalopenid: 'wm_family' },
        // 未知状态与缺 id 的条目不写入
        { agree_status: 'Unknown', exteranalopenid: 'wm_unknown' },
        { agree_status: 'Agree' },
      ],
    }),
  ]);
  const agree = client(rec.fetchImpl, clock, { logger: (line) => logs.push(line) });

  assert.equal(agree.enabled, true);
  const statuses = await agree.roomConsent('wr_group_1');

  assert.deepEqual(statuses, { wm_star: 'agreed', wm_family: 'disagreed' });
  assert.deepEqual(rec.bodies[0], { roomid: 'wr_group_1' });

  // 缓存命中：token 与群结果都不再请求
  await agree.roomConsent('wr_group_1');
  assert.equal(rec.roomCalls, 1);
  assert.equal(rec.urls.filter((url) => url.includes('/gettoken')).length, 1);

  // 外部联系人 id 与凭据都不落日志
  const text = logs.join('\n');
  assert.ok(!text.includes('wm_star'), text);
  assert.ok(!text.includes(ARCHIVE_SECRET), text);
});

test('token 失效时清缓存并立即重试一次', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const rec = recorder([
    () => ({ errcode: 42001, errmsg: 'access_token expired' }),
    () => ({ errcode: 0, agreeinfo: [{ agree_status: 'Agree', exteranalopenid: 'wm_star' }] }),
  ]);
  const agree = client(rec.fetchImpl, clock);

  const statuses = await agree.roomConsent('wr_group_1');

  assert.deepEqual(statuses, { wm_star: 'agreed' });
  assert.equal(rec.urls.filter((url) => url.includes('/gettoken')).length, 2);
  assert.equal(rec.roomCalls, 2);
});

test('权限失败返回 undefined，并做负缓存避免反复调用', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const logs: string[] = [];
  const rec = recorder([() => ({ errcode: 90501, errmsg: 'internal room' })]);
  const agree = client(rec.fetchImpl, clock, { logger: (line) => logs.push(line) });

  assert.equal(await agree.roomConsent('wr_group_1'), undefined);
  assert.equal(await agree.roomConsent('wr_group_1'), undefined);
  assert.equal(rec.roomCalls, 1);
  assert.match(logs.join('\n'), /errcode=90501/);
});

test('无凭据时禁用，不发起任何请求', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const rec = recorder([() => ({ errcode: 0, agreeinfo: [] })]);
  const agree = new RoomAgreeClient({ clock, fetchImpl: rec.fetchImpl });

  assert.equal(agree.enabled, false);
  assert.equal(await agree.roomConsent('wr_group_1'), undefined);
  assert.equal(rec.urls.length, 0);
});

test('从存档 config.txt 读取 corpid 与会话存档 Secret', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const rec = recorder([() => ({ errcode: 0, agreeinfo: [] })]);
  const agree = new RoomAgreeClient({
    configPath: '/etc/zhiban/archive/config.txt',
    clock,
    fetchImpl: rec.fetchImpl,
    readFile: (path) => {
      assert.equal(path, '/etc/zhiban/archive/config.txt');
      return `${CORP_ID}\n${ARCHIVE_SECRET}\n`;
    },
  });

  assert.equal(agree.enabled, true);
  await agree.roomConsent('wr_group_1');
  const tokenUrl = rec.urls.find((url) => url.includes('/gettoken'));
  assert.ok(tokenUrl?.includes(`corpid=${CORP_ID}`), tokenUrl);
  assert.ok(tokenUrl?.includes(`corpsecret=${ARCHIVE_SECRET}`), tokenUrl);
});

test('凭据文件不可读时保持禁用，不影响调用方', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const agree = new RoomAgreeClient({
    configPath: '/missing/config.txt',
    clock,
    readFile: () => {
      throw new Error('EACCES');
    },
  });

  assert.equal(agree.enabled, false);
  assert.equal(await agree.roomConsent('wr_group_1'), undefined);
});

test('parseArchiveConfig 与同意状态映射', () => {
  assert.deepEqual(parseArchiveConfig('corp_x\r\nsecret_y\r\n'), {
    corpId: 'corp_x',
    secret: 'secret_y',
  });
  assert.deepEqual(parseArchiveConfig('\n\n'), { corpId: undefined, secret: undefined });
  assert.equal(consentFromAgreeStatus('Agree'), 'agreed');
  assert.equal(consentFromAgreeStatus('Disagree'), 'disagreed');
  assert.equal(consentFromAgreeStatus('Pending'), undefined);
  assert.equal(consentFromAgreeStatus(undefined), undefined);
});
