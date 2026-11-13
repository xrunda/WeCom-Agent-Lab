/**
 * zhiban-sidebar 插件配置（#146 / #145）。
 *
 * 只包含判定参数与必填凭据；凭据不打印、不落日志。
 */
export interface SidebarPluginConfigInput {
  tenantId?: unknown;
  /** 机器人 / 自建应用的 userid；这些发言不算顾问已回复 */
  botUserIds?: unknown;
  /** 侧边栏会话令牌签名密钥；不配置则接口一律 401 */
  sessionSecret?: unknown;
  /** 企微自建应用：corpid / agentid / secret，用于 OAuth 与 JS-SDK 签名 */
  corpId?: unknown;
  agentId?: unknown;
  agentSecret?: unknown;
  /** 侧边栏公网地址，如 https://zhiban.example.com；用于拼 OAuth 回调与签名校验 */
  publicBaseUrl?: unknown;
  /** 会话有效期 */
  sessionTtlMs?: unknown;
  mergeWindowMs?: unknown;
  seenRetentionDays?: unknown;
  closedRetentionDays?: unknown;
}

export interface SidebarPluginConfig {
  tenantId: string;
  botUserIds: string[];
  sessionSecret?: string;
  corpId?: string;
  agentId?: string;
  agentSecret?: string;
  publicBaseUrl?: string;
  sessionTtlMs: number;
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
  const publicBaseUrl = optionalBaseUrl(input.publicBaseUrl);
  return {
    tenantId: optionalString(input.tenantId, 'tenantId', 'default'),
    botUserIds: stringList(input.botUserIds, 'botUserIds'),
    ...(typeof input.sessionSecret === 'string' && input.sessionSecret.trim() !== ''
      ? { sessionSecret: input.sessionSecret.trim() }
      : {}),
    ...optionalTrimmed(input.corpId, 'corpId'),
    ...optionalTrimmed(input.agentId, 'agentId'),
    ...optionalTrimmed(input.agentSecret, 'agentSecret'),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    sessionTtlMs: positiveNumber(input.sessionTtlMs, 'sessionTtlMs', 8 * 60 * 60_000),
    mergeWindowMs: positiveNumber(input.mergeWindowMs, 'mergeWindowMs', 10 * 60_000),
    seenRetentionDays: positiveNumber(input.seenRetentionDays, 'seenRetentionDays', 7),
    closedRetentionDays: positiveNumber(input.closedRetentionDays, 'closedRetentionDays', 7),
  };
}

function optionalTrimmed(
  value: unknown,
  field: string,
): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SidebarConfigError('CONFIG_INVALID', `${field} 必须是非空字符串`);
  }
  return { [field]: value.trim() };
}

function optionalBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new SidebarConfigError('CONFIG_INVALID', 'publicBaseUrl 必须是字符串');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new SidebarConfigError('CONFIG_INVALID', 'publicBaseUrl 必须是完整 URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SidebarConfigError('CONFIG_INVALID', 'publicBaseUrl 只支持 http/https');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function retentionMs(days: number): number {
  return days * DAY_MS;
}
