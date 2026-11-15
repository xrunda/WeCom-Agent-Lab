/**
 * zhiban-advisor 插件配置解析（#167）。
 *
 * 约定与其它插件一致：配置来自 DSH profile 的插件配置，不从代码里读死值。
 * 本插件没有 Secret。
 */

export interface AdvisorPluginConfigInput {
  workspaceRoot?: unknown;
  agentPreset?: unknown;
  turnTimeoutMs?: unknown;
  maxConcurrentTurns?: unknown;
  messagesPerMinute?: unknown;
  messagesPerDay?: unknown;
  enabled?: unknown;
}

export interface AdvisorPluginConfig {
  workspaceRoot: string;
  agentPreset?: string;
  turnTimeoutMs: number;
  maxConcurrentTurns: number;
  messagesPerMinute: number;
  messagesPerDay: number;
  enabled: boolean;
}

export class AdvisorConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdvisorConfigError';
    this.code = code;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdvisorConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new AdvisorConfigError('CONFIG_INVALID', `${field} 必须是字符串`);
  }
  return value.trim() || undefined;
}

function boundedInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new AdvisorConfigError('CONFIG_INVALID', `${field} 需为 ${min}–${max} 的整数`);
  }
  return value;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new AdvisorConfigError('CONFIG_INVALID', `${field} 必须是布尔值`);
  }
  return value;
}

export function parseAdvisorConfig(raw: unknown): AdvisorPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AdvisorConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as AdvisorPluginConfigInput;
  return {
    workspaceRoot: requiredString(input.workspaceRoot, 'workspaceRoot'),
    agentPreset: optionalString(input.agentPreset, 'agentPreset'),
    turnTimeoutMs: boundedInt(input.turnTimeoutMs, 'turnTimeoutMs', 5_000, 300_000, 30_000),
    maxConcurrentTurns: boundedInt(input.maxConcurrentTurns, 'maxConcurrentTurns', 1, 8, 2),
    messagesPerMinute: boundedInt(input.messagesPerMinute, 'messagesPerMinute', 1, 300, 20),
    messagesPerDay: boundedInt(input.messagesPerDay, 'messagesPerDay', 10, 10_000, 500),
    enabled: bool(input.enabled, 'enabled', true),
  };
}
