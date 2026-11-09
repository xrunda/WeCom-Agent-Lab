/**
 * #52 部署看门狗。
 *
 * 每 5 分钟检查四类信号：DSH Host、存档拉取、机器人长连接、模型可用性。
 * 单项异常持续超过阈值（默认 10 分钟）才通知运维；恢复后再通知一次。
 *
 * 设计约束：
 * - 不记录、不打印消息正文和任何凭据。
 * - 状态文件原子写入，进程重启不会重复通知。
 * - 外部探针全部可注入，便于单测；默认探针只读本地状态文件或发 HTTP 请求。
 *
 * 运行：`node --experimental-strip-types src/ops/watchdog.ts [--once]`
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type CheckName = 'host' | 'archive' | 'bot' | 'model';

export const CHECK_LABELS: Record<CheckName, string> = {
  host: 'DSH Host',
  archive: '存档拉取',
  bot: '机器人长连接',
  model: '模型服务',
};

export interface CheckSample {
  name: CheckName;
  ok: boolean;
  /** 失败原因摘要；不得包含消息正文或凭据 */
  reason?: string;
}

export interface CheckState {
  /** 首次观察到失败的时间；恢复后清空 */
  failingSince: number | null;
  /** 是否已经发过「持续异常」通知 */
  notified: boolean;
}

export interface WatchdogState {
  version: 1;
  checks: Partial<Record<CheckName, CheckState>>;
}

export interface WatchdogNotification {
  check: CheckName;
  kind: 'down' | 'up';
  failingSince: number;
  reason?: string;
}

export interface Evaluation {
  state: WatchdogState;
  notifications: WatchdogNotification[];
}

export const EMPTY_STATE: WatchdogState = { version: 1, checks: {} };

/**
 * 纯状态机：根据本轮采样与上一轮状态决定是否通知。
 *
 * - 首次失败只记时间，不通知；
 * - 连续失败达到 `failAfterMs` 才通知一次；
 * - 已通知后继续失败不重复；
 * - 恢复时若曾通知过，发一次恢复通知。
 */
export function evaluateWatchdog(
  previous: WatchdogState,
  samples: CheckSample[],
  now: number,
  failAfterMs: number,
): Evaluation {
  const checks: WatchdogState['checks'] = { ...previous.checks };
  const notifications: WatchdogNotification[] = [];

  for (const sample of samples) {
    const previousCheck = checks[sample.name] ?? { failingSince: null, notified: false };

    if (sample.ok) {
      if (previousCheck.notified) {
        notifications.push({
          check: sample.name,
          kind: 'up',
          failingSince: previousCheck.failingSince ?? now,
        });
      }
      checks[sample.name] = { failingSince: null, notified: false };
      continue;
    }

    const failingSince = previousCheck.failingSince ?? now;
    const shouldNotify =
      !previousCheck.notified && now - failingSince >= Math.max(0, failAfterMs);
    if (shouldNotify) {
      notifications.push({
        check: sample.name,
        kind: 'down',
        failingSince,
        ...(sample.reason ? { reason: sample.reason } : {}),
      });
    }
    checks[sample.name] = { failingSince, notified: previousCheck.notified || shouldNotify };
  }

  return { state: { version: 1, checks }, notifications };
}

export function formatNotification(notification: WatchdogNotification, now = Date.now()): string {
  const label = CHECK_LABELS[notification.check];
  if (notification.kind === 'up') {
    return `【知伴恢复】${label} 已恢复正常（异常开始于 ${formatTime(notification.failingSince)}）。`;
  }
  const minutes = Math.max(1, Math.round((now - notification.failingSince) / 60_000));
  const reason = notification.reason ? `原因：${notification.reason}` : '未提供原因';
  return `【知伴告警】${label} 异常已持续约 ${minutes} 分钟。${reason}。请检查服务与企微后台。`;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/* ---------- 探针 ---------- */

export interface ProbeOptions {
  timeoutMs: number;
  statusStaleMs: number;
  now: number;
}

/** DSH Host：任意 < 500 的 HTTP 响应都说明进程与端口存活 */
export async function probeHost(
  url: string,
  options: ProbeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckSample> {
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (response.status >= 500) {
      return { name: 'host', ok: false, reason: `HTTP ${response.status}` };
    }
    return { name: 'host', ok: true };
  } catch {
    // 不输出异常 message，避免把内部 URL 带进日志
    return { name: 'host', ok: false, reason: '无法连接 DSH Host' };
  }
}

function readStatusFile<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** 存档拉取：状态文件由运维侧状态采集器写入，字段见 docs/P1-deploy.md */
export function probeArchive(statusDir: string, options: ProbeOptions): CheckSample {
  const status = readStatusFile<{ lastPolledAt?: number }>(join(statusDir, 'archive-status.json'));
  if (!status || typeof status.lastPolledAt !== 'number') {
    return { name: 'archive', ok: false, reason: '存档状态文件缺失或格式错误' };
  }
  const age = options.now - status.lastPolledAt;
  if (age > options.statusStaleMs) {
    return { name: 'archive', ok: false, reason: `最近一次拉取已过去 ${Math.round(age / 1000)} 秒` };
  }
  return { name: 'archive', ok: true };
}

/** 机器人长连接：状态文件由运维侧状态采集器写入 */
export function probeBot(statusDir: string): CheckSample {
  const status = readStatusFile<{ connected?: boolean }>(join(statusDir, 'bot-status.json'));
  if (!status || typeof status.connected !== 'boolean') {
    return { name: 'bot', ok: false, reason: '机器人状态文件缺失或格式错误' };
  }
  return status.connected
    ? { name: 'bot', ok: true }
    : { name: 'bot', ok: false, reason: '长连接已断开' };
}

/** 模型可用性：状态文件由运维侧状态采集器写入 */
export function probeModel(statusDir: string, options: ProbeOptions): CheckSample {
  const status = readStatusFile<{ ok?: boolean; checkedAt?: number }>(
    join(statusDir, 'model-status.json'),
  );
  if (!status || typeof status.ok !== 'boolean' || typeof status.checkedAt !== 'number') {
    return { name: 'model', ok: false, reason: '模型状态文件缺失或格式错误' };
  }
  if (!status.ok) return { name: 'model', ok: false, reason: '最近一次模型探测失败' };
  const age = options.now - status.checkedAt;
  if (age > options.statusStaleMs) {
    return { name: 'model', ok: false, reason: `模型探测结果已过期 ${Math.round(age / 1000)} 秒` };
  }
  return { name: 'model', ok: true };
}

/* ---------- 状态持久化与通知 ---------- */

export function loadState(path: string): WatchdogState {
  const parsed = readStatusFile<WatchdogState>(path);
  if (!parsed || parsed.version !== 1 || typeof parsed.checks !== 'object') return EMPTY_STATE;
  return parsed;
}

export function saveState(path: string, state: WatchdogState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
  renameSync(tmp, path);
}

export interface NotifyOptions {
  webhookUrl?: string;
  command?: string;
  fetchImpl?: typeof fetch;
}

/** 通知渠道失败只记日志，不影响状态推进，避免重复告警风暴 */
export async function notify(
  text: string,
  options: NotifyOptions,
  log: (line: string) => void = (line) => console.log(line),
): Promise<boolean> {
  let delivered = false;
  if (options.webhookUrl) {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) delivered = true;
      else log(`通知 webhook 返回 HTTP ${response.status}`);
    } catch {
      log('通知 webhook 请求失败');
    }
  }
  if (options.command) {
    try {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('sh', ['-c', options.command], {
        input: text,
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (result.status === 0) delivered = true;
      else log(`通知命令退出码 ${result.status ?? 'unknown'}`);
    } catch {
      log('通知命令执行失败');
    }
  }
  return delivered;
}

/* ---------- 单轮执行 ---------- */

export interface WatchdogConfig {
  hostUrl: string;
  statusDir: string;
  stateFile: string;
  failAfterMs: number;
  statusStaleMs: number;
  timeoutMs: number;
  webhookUrl?: string;
  command?: string;
}

export function readWatchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    hostUrl: env.ZHIBAN_WATCHDOG_HOST_URL?.trim() || 'http://127.0.0.1:3080/',
    statusDir: env.ZHIBAN_WATCHDOG_STATUS_DIR?.trim() || '/var/lib/zhiban/status',
    stateFile: env.ZHIBAN_WATCHDOG_STATE_FILE?.trim() || '/var/lib/zhiban/state/watchdog.json',
    failAfterMs: number(env.ZHIBAN_WATCHDOG_FAIL_AFTER_MS, 10 * 60_000),
    statusStaleMs: number(env.ZHIBAN_WATCHDOG_STATUS_STALE_MS, 10 * 60_000),
    timeoutMs: number(env.ZHIBAN_WATCHDOG_TIMEOUT_MS, 5_000),
    webhookUrl: env.ZHIBAN_WATCHDOG_WEBHOOK_URL?.trim() || undefined,
    command: env.ZHIBAN_WATCHDOG_NOTIFY_CMD?.trim() || undefined,
  };
}

export interface WatchdogRunResult {
  samples: CheckSample[];
  notifications: WatchdogNotification[];
  state: WatchdogState;
}

export async function runWatchdogOnce(
  config: WatchdogConfig,
  options: {
    now?: number;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
    notifyImpl?: typeof notify;
  } = {},
): Promise<WatchdogRunResult> {
  const now = options.now ?? Date.now();
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchImpl = options.fetchImpl ?? fetch;
  const probeOptions: ProbeOptions = {
    timeoutMs: config.timeoutMs,
    statusStaleMs: config.statusStaleMs,
    now,
  };

  const samples: CheckSample[] = [
    await probeHost(config.hostUrl, probeOptions, fetchImpl),
    probeArchive(config.statusDir, probeOptions),
    probeBot(config.statusDir),
    probeModel(config.statusDir, probeOptions),
  ];

  const previous = loadState(config.stateFile);
  const evaluation = evaluateWatchdog(previous, samples, now, config.failAfterMs);
  saveState(config.stateFile, evaluation.state);

  for (const sample of samples) {
    log(`[${sample.ok ? 'ok' : 'fail'}] ${CHECK_LABELS[sample.name]}${sample.reason ? `：${sample.reason}` : ''}`);
  }

  const send = options.notifyImpl ?? notify;
  for (const notification of evaluation.notifications) {
    const text = formatNotification(notification, now);
    log(text);
    await send(
      text,
      {
        ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
        ...(config.command ? { command: config.command } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
      log,
    );
  }

  return { samples, notifications: evaluation.notifications, state: evaluation.state };
}

/* ---------- CLI ---------- */

const INTERVAL_MS = 5 * 60_000;

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = readWatchdogConfig();
  if (!config.webhookUrl && !config.command) {
    console.error('未配置通知渠道（ZHIBAN_WATCHDOG_WEBHOOK_URL 或 ZHIBAN_WATCHDOG_NOTIFY_CMD），仅记录日志');
  }

  const tick = async (): Promise<void> => {
    try {
      await runWatchdogOnce(config);
    } catch (error) {
      // 只记录错误类型，不打印可能含路径/凭据的细节
      console.error(`看门狗执行失败：${error instanceof Error ? error.name : 'unknown'}`);
    }
  };

  await tick();
  if (once) return;

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  void main();
}
