import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WecomConfigError,
  parsePluginConfig,
  serviceGroupFilter,
} from '../plugins/zhiban-wecom/config.ts';

const BOT_SECRET = 'secret-should-never-appear';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: 'demo',
    demoBotId: 'demo-bot',
    botId: 'demo-bot',
    botSecret: BOT_SECRET,
    archive: {
      binaryPath: '/opt/archive_dump',
      privateKeyPath: '/opt/private_key.pem',
      configPath: '/opt/config.txt',
    },
    serviceGroupRoomIds: ['wrGROUP1'],
    advisorId: 'adv_1',
    advisorName: '王顾问',
    advisorChatId: 'adv_1',
    groupName: '减重-张女士',
    mediaRootDir: '/var/lib/dsh/zhiban/media',
    ...overrides,
  };
}

test('合法配置补齐默认轮询与批大小', () => {
  const config = parsePluginConfig(raw(), {});

  assert.equal(config.environment, 'demo');
  assert.equal(config.pollIntervalMs, 5_000);
  assert.equal(config.tickIntervalMs, 5_000);
  assert.equal(config.downtimeThresholdMs, 600_000);
  assert.equal(config.archive.batchSize, 100);
  assert.equal(config.archive.maxBatchesPerPoll, 5);
  assert.equal(config.archive.cacheLimit, 2_000);
});

test('缺少必填项时报 CONFIG_REQUIRED 且不回显 Secret', () => {
  const input = raw();
  delete input.botSecret;

  assert.throws(
    () => parsePluginConfig(input, {}),
    (error: unknown) =>
      error instanceof WecomConfigError &&
      error.code === 'CONFIG_REQUIRED' &&
      /botSecret/.test(error.message) &&
      !error.message.includes(BOT_SECRET),
  );
});

test('ZHIBAN_ENV 与插件环境不一致时拒绝启动', () => {
  assert.throws(
    () => parsePluginConfig(raw(), { ZHIBAN_ENV: 'dev' }),
    (error: unknown) => error instanceof WecomConfigError && error.code === 'ENV_MISMATCH',
  );
});

test('dev 环境使用 demo 机器人 BOT_ID 时拒绝启动（F14）', () => {
  assert.throws(
    () => parsePluginConfig(raw({ environment: 'dev' }), { ZHIBAN_ENV: 'dev' }),
    (error: unknown) =>
      error instanceof WecomConfigError &&
      error.code === 'ENV_BOT_CONFLICT' &&
      /知伴-开发/.test(error.message),
  );
});

test('dev 环境使用独立机器人可以启动', () => {
  const config = parsePluginConfig(
    raw({ environment: 'dev', botId: 'dev-bot', botSecret: 'dev-secret' }),
    { ZHIBAN_ENV: 'dev' },
  );

  assert.equal(config.environment, 'dev');
  assert.equal(config.botId, 'dev-bot');
});

test('群白名单去重且不能为空', () => {
  const config = parsePluginConfig(
    raw({ serviceGroupRoomIds: ['wrA', 'wrB', 'wrA', '  '] }),
    {},
  );
  assert.deepEqual(config.serviceGroupRoomIds, ['wrA', 'wrB']);

  assert.throws(
    () => parsePluginConfig(raw({ serviceGroupRoomIds: [] }), {}),
    (error: unknown) => error instanceof WecomConfigError && error.code === 'CONFIG_REQUIRED',
  );
});

test('轮询间隔越界时报 CONFIG_INVALID', () => {
  assert.throws(
    () => parsePluginConfig(raw({ pollIntervalMs: 100 }), {}),
    (error: unknown) => error instanceof WecomConfigError && error.code === 'CONFIG_INVALID',
  );
  assert.throws(
    () => parsePluginConfig(raw({ pollIntervalMs: 3.5 }), {}),
    (error: unknown) => error instanceof WecomConfigError && error.code === 'CONFIG_INVALID',
  );
});

test('归档配置缺失时报 CONFIG_REQUIRED', () => {
  assert.throws(
    () => parsePluginConfig(raw({ archive: undefined }), {}),
    (error: unknown) => error instanceof WecomConfigError && error.code === 'CONFIG_REQUIRED',
  );
});

test('群过滤器只放行白名单内的群', () => {
  const config = parsePluginConfig(raw(), {});
  const filter = serviceGroupFilter(config);

  assert.equal(filter('wrGROUP1'), true);
  assert.equal(filter('wrOTHER'), false);
  assert.equal(filter(''), false);
});
