/**
 * zhiban-sidebar 插件配置（#146）。
 *
 * 只包含判定参数，不读取任何密钥。
 */
export interface SidebarPluginConfigInput {
  tenantId?: unknown;
  /** 机器人 / 自建应用的 userid；这些发言不算顾问已回复 */
  botUserIds?: unknown;
  mergeWindowMs?: unknown;
  seenRetentionDays?: unknown;
  closedRetentionDays?: unknown;
}

export interface SidebarPluginConfig {
  tenantId: string;
  botUserIds: string[];
  mergeWindowMs: number;
  seenRetentionDays: number;
  closedRetentionDays: number;
}

export class SidebarConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SidebarConfigError';
    this.code = code;
  }
}

const DAY_MS = 24 * 60 * 60_000;

function optionalString(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SidebarConfigError('CONFIG_INVALID', `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new SidebarConfigError('CONFIG_INVALID', `${field} 必须是字符串数组`);
  }
  return value.map((item) => (item as string).trim()).filter((item) => item !== '');
}

function positiveNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SidebarConfigError('CONFIG_INVALID', `${field} 必须是正数`);
  }
  return value;
}

export function parseSidebarConfig(raw: unknown): SidebarPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SidebarConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as SidebarPluginConfigInput;
  return {
    tenantId: optionalString(input.tenantId, 'tenantId', 'default'),
    botUserIds: stringList(input.botUserIds, 'botUserIds'),
    mergeWindowMs: positiveNumber(input.mergeWindowMs, 'mergeWindowMs', 10 * 60_000),
    seenRetentionDays: positiveNumber(input.seenRetentionDays, 'seenRetentionDays', 7),
    closedRetentionDays: positiveNumber(input.closedRetentionDays, 'closedRetentionDays', 7),
  };
}

export function retentionMs(days: number): number {
  return days * DAY_MS;
}
