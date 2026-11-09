/**
 * #52 模型费用日报。
 *
 * 读取运维侧状态采集器写入的 `model-status.json`，每天把调用次数与估算费用
 * 推给我方负责人。**读不到状态文件时直接报错退出**，不编造数字。
 *
 * 运行：`node --experimental-strip-types src/ops/daily-report.ts`
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { notify } from './watchdog.ts';

export interface ModelUsage {
  model?: string;
  callsToday: number;
  estimatedCostYuanToday: number;
  fallbackCount?: number;
  updatedAt: number;
}

export function parseModelUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.callsToday !== 'number' || !Number.isFinite(value.callsToday)) return undefined;
  if (
    typeof value.estimatedCostYuanToday !== 'number' ||
    !Number.isFinite(value.estimatedCostYuanToday)
  ) {
    return undefined;
  }
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined;
  return {
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    callsToday: value.callsToday,
    estimatedCostYuanToday: value.estimatedCostYuanToday,
    ...(typeof value.fallbackCount === 'number' ? { fallbackCount: value.fallbackCount } : {}),
    updatedAt: value.updatedAt,
  };
}

export function readModelUsage(statusDir: string): ModelUsage | undefined {
  const path = join(statusDir, 'model-status.json');
  try {
    if (!existsSync(path)) return undefined;
    return parseModelUsage(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

export function buildDailyReport(usage: ModelUsage, now = Date.now()): string {
  const updated = new Date(usage.updatedAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  const lines = [
    `【知伴日报】${new Date(now).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })} 模型费用`,
    `调用次数：${usage.callsToday} 次`,
    `估算费用：¥${usage.estimatedCostYuanToday.toFixed(2)}`,
  ];
  if (usage.model) lines.push(`模型：${usage.model}`);
  if (usage.fallbackCount !== undefined) lines.push(`降级次数：${usage.fallbackCount} 次`);
  lines.push(`统计时间：${updated}`);
  return lines.join('\n');
}

export interface ReportConfig {
  statusDir: string;
  webhookUrl?: string;
  command?: string;
  dryRun: boolean;
}

export function readReportConfig(env: NodeJS.ProcessEnv = process.env): ReportConfig {
  return {
    statusDir: env.ZHIBAN_REPORT_STATUS_DIR?.trim() || '/var/lib/zhiban/status',
    webhookUrl: env.ZHIBAN_REPORT_WEBHOOK_URL?.trim() || undefined,
    command: env.ZHIBAN_REPORT_NOTIFY_CMD?.trim() || undefined,
    dryRun: env.ZHIBAN_REPORT_DRY_RUN === '1',
  };
}

export async function sendDailyReport(
  config: ReportConfig,
  options: { now?: number; notifyImpl?: typeof notify } = {},
): Promise<{ sent: boolean; text?: string }> {
  const usage = readModelUsage(config.statusDir);
  if (!usage) {
    console.error('模型状态文件缺失或格式错误，未发送日报（不编造数字）');
    return { sent: false };
  }
  const text = buildDailyReport(usage, options.now ?? Date.now());
  if (config.dryRun) {
    console.log(text);
    return { sent: false, text };
  }
  const delivered = await (options.notifyImpl ?? notify)(text, {
    ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
    ...(config.command ? { command: config.command } : {}),
  });
  return { sent: delivered, text };
}

async function main(): Promise<void> {
  const config = readReportConfig();
  if (!config.webhookUrl && !config.command && !config.dryRun) {
    console.error('未配置通知渠道（ZHIBAN_REPORT_WEBHOOK_URL 或 ZHIBAN_REPORT_NOTIFY_CMD）');
    process.exitCode = 2;
    return;
  }
  const result = await sendDailyReport(config);
  if (!result.text) process.exitCode = 1;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  void main();
}
