import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  EMPTY_STATE,
  evaluateWatchdog,
  formatNotification,
  probeArchive,
  probeBot,
  probeHost,
  probeModel,
  readWatchdogConfig,
  runWatchdogOnce,
  type CheckSample,
  type WatchdogConfig,
} from '../src/ops/watchdog.ts';
import {
  buildDailyReport,
  parseModelUsage,
  readModelUsage,
  sendDailyReport,
} from '../src/ops/daily-report.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhiban-ops-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MINUTE = 60_000;

function statusDir(overrides: { archiveAt?: number; botConnected?: boolean; modelOk?: boolean; modelAt?: number } = {}): string {
  const dir = tempDir();
  const now = Date.now();
  writeFileSync(
    join(dir, 'archive-status.json'),
    JSON.stringify({ lastPolledAt: overrides.archiveAt ?? now }),
  );
  writeFileSync(
    join(dir, 'bot-status.json'),
    JSON.stringify({ connected: overrides.botConnected ?? true }),
  );
  writeFileSync(
    join(dir, 'model-status.json'),
    JSON.stringify({ ok: overrides.modelOk ?? true, checkedAt: overrides.modelAt ?? now }),
  );
  return dir;
}

function options(now: number) {
  return { timeoutMs: 1_000, statusStaleMs: 10 * MINUTE, now };
}

describe('#52 看门狗状态机', () => {
  it('首次失败只记录，持续达到阈值才通知一次', () => {
    const fail: CheckSample[] = [{ name: 'bot', ok: false, reason: '长连接已断开' }];
    const first = evaluateWatchdog(EMPTY_STATE, fail, 1_000, 10 * MINUTE);
    assert.equal(first.notifications.length, 0);
    assert.equal(first.state.checks.bot?.failingSince, 1_000);

    const before = evaluateWatchdog(first.state, fail, 1_000 + 9 * MINUTE, 10 * MINUTE);
    assert.equal(before.notifications.length, 0);

    const atThreshold = evaluateWatchdog(before.state, fail, 1_000 + 10 * MINUTE, 10 * MINUTE);
    assert.equal(atThreshold.notifications.length, 1);
    assert.equal(atThreshold.notifications[0]?.kind, 'down');
    assert.equal(atThreshold.notifications[0]?.check, 'bot');

    const again = evaluateWatchdog(atThreshold.state, fail, 1_000 + 20 * MINUTE, 10 * MINUTE);
    assert.equal(again.notifications.length, 0, '持续异常不重复通知');
  });

  it('恢复时通知一次，并清空失败状态', () => {
    const fail: CheckSample[] = [{ name: 'archive', ok: false }];
    const ok: CheckSample[] = [{ name: 'archive', ok: true }];
    const down = evaluateWatchdog(EMPTY_STATE, fail, 0, 0);
    assert.equal(down.notifications[0]?.kind, 'down');

    const recovered = evaluateWatchdog(down.state, ok, 5 * MINUTE, 0);
    assert.equal(recovered.notifications.length, 1);
    assert.equal(recovered.notifications[0]?.kind, 'up');
    assert.equal(recovered.state.checks.archive?.failingSince, null);
    assert.equal(recovered.state.checks.archive?.notified, false);
  });

  it('阈值内的短暂失败不通知，恢复后也不发恢复消息', () => {
    const fail: CheckSample[] = [{ name: 'model', ok: false }];
    const ok: CheckSample[] = [{ name: 'model', ok: true }];
    const first = evaluateWatchdog(EMPTY_STATE, fail, 0, 10 * MINUTE);
    const recovered = evaluateWatchdog(first.state, ok, 2 * MINUTE, 10 * MINUTE);
    assert.equal(recovered.notifications.length, 0);
    assert.equal(recovered.state.checks.model?.failingSince, null);
  });

  it('通知文案只含检查项与原因，不含正文', () => {
    const text = formatNotification(
      { check: 'bot', kind: 'down', failingSince: 0, reason: '长连接已断开' },
      12 * MINUTE,
    );
    assert.match(text, /机器人长连接/);
    assert.match(text, /约 12 分钟/);
    assert.match(text, /长连接已断开/);
  });
});

describe('#52 看门狗探针', () => {
  it('DSH Host：< 500 视为存活，5xx 或连接失败视为异常', async () => {
    const okFetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const redirectFetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
    const badFetch = (async () => new Response('bad', { status: 502 })) as typeof fetch;
    const downFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    assert.equal((await probeHost('http://127.0.0.1:3080/', options(0), okFetch)).ok, true);
    assert.equal((await probeHost('http://127.0.0.1:3080/', options(0), redirectFetch)).ok, true);
    const bad = await probeHost('http://127.0.0.1:3080/', options(0), badFetch);
    assert.equal(bad.ok, false);
    assert.match(bad.reason ?? '', /HTTP 502/);
    const down = await probeHost('http://127.0.0.1:3080/', options(0), downFetch);
    assert.equal(down.ok, false);
    assert.doesNotMatch(down.reason ?? '', /ECONNREFUSED/, '不把底层异常带进日志');
  });

  it('存档 / 机器人 / 模型状态文件缺失或过期时判定异常', () => {
    const missing = tempDir();
    assert.equal(probeArchive(missing, options(0)).ok, false);
    assert.equal(probeBot(missing).ok, false);
    assert.equal(probeModel(missing, options(0)).ok, false);

    const fresh = statusDir({ archiveAt: 1_000, modelAt: 1_000 });
    assert.equal(probeArchive(fresh, options(2_000)).ok, true);
    assert.equal(probeBot(fresh).ok, true);
    assert.equal(probeModel(fresh, options(2_000)).ok, true);

    const stale = statusDir({ archiveAt: 1_000, modelAt: 1_000 });
    const late = options(20 * MINUTE);
    assert.equal(probeArchive(stale, late).ok, false);
    assert.equal(probeModel(stale, late).ok, false);

    const disconnected = statusDir({ botConnected: false });
    assert.equal(probeBot(disconnected).ok, false);
    const modelDown = statusDir({ modelOk: false });
    assert.equal(probeModel(modelDown, options(Date.now())).ok, false);
  });
});

describe('#52 看门狗单轮执行', () => {
  it('跨轮次持久化状态，异常达标后只通知一次', async () => {
    const dir = statusDir({ botConnected: false });
    const stateFile = join(tempDir(), 'state', 'watchdog.json');
    const config: WatchdogConfig = {
      hostUrl: 'http://127.0.0.1:3080/',
      statusDir: dir,
      stateFile,
      failAfterMs: 10 * MINUTE,
      statusStaleMs: 10 * MINUTE,
      timeoutMs: 1_000,
      command: 'true',
    };
    const okFetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const sent: string[] = [];
    const notifyImpl = (async (text: string) => {
      sent.push(text);
      return true;
    }) as typeof import('../src/ops/watchdog.ts').notify;

    const base = Date.now();
    // 状态文件的 lastPolledAt/checkedAt 以真实时间为准，用真实 now 推进会导致过期；
    // 这里只关心 bot 失败，其他项用真实时间保持新鲜。
    const round1 = await runWatchdogOnce(config, {
      now: base,
      fetchImpl: okFetch,
      log: () => {},
      notifyImpl,
    });
    assert.equal(round1.notifications.length, 0);

    const round2 = await runWatchdogOnce(config, {
      now: base + 11 * MINUTE,
      fetchImpl: okFetch,
      log: () => {},
      notifyImpl,
    });
    // 存档/模型状态文件以 base 写入，此时也会过期并发通知；只断言 bot 通知存在且仅一次。
    const botDown = round2.notifications.filter((item) => item.check === 'bot' && item.kind === 'down');
    assert.equal(botDown.length, 1);

    const round3 = await runWatchdogOnce(config, {
      now: base + 12 * MINUTE,
      fetchImpl: okFetch,
      log: () => {},
      notifyImpl,
    });
    assert.equal(round3.notifications.filter((item) => item.check === 'bot').length, 0);
    assert.ok(sent.some((text) => text.includes('机器人长连接')));
  });
});

describe('#52 看门狗配置与日报', () => {
  it('配置项有安全默认值，不接受非正数', () => {
    const config = readWatchdogConfig({
      ZHIBAN_WATCHDOG_FAIL_AFTER_MS: '-1',
      ZHIBAN_WATCHDOG_TIMEOUT_MS: 'abc',
    } as NodeJS.ProcessEnv);
    assert.equal(config.failAfterMs, 10 * MINUTE);
    assert.equal(config.timeoutMs, 5_000);
    assert.equal(config.hostUrl, 'http://127.0.0.1:3080/');
  });

  it('日报只使用真实状态文件，缺失时明确失败', async () => {
    assert.equal(parseModelUsage({ callsToday: 'x' }), undefined);

    const dir = tempDir();
    writeFileSync(
      join(dir, 'model-status.json'),
      JSON.stringify({
        model: 'deepseek-flash',
        callsToday: 142,
        estimatedCostYuanToday: 0.86,
        fallbackCount: 3,
        updatedAt: Date.parse('2026-11-10T01:00:00Z'),
      }),
    );
    const usage = readModelUsage(dir);
    assert.ok(usage);
    const text = buildDailyReport(usage!, Date.parse('2026-11-10T02:00:00Z'));
    assert.match(text, /调用次数：142 次/);
    assert.match(text, /估算费用：¥0\.86/);
    assert.match(text, /降级次数：3 次/);

    const missing = tempDir();
    const result = await sendDailyReport(
      { statusDir: missing, dryRun: true },
      { now: Date.parse('2026-11-10T02:00:00Z') },
    );
    assert.equal(result.sent, false);
    assert.equal(result.text, undefined);
  });
});
