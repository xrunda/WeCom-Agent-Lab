/**
 * zhiban-patient 插件配置（#33 / #34 / #56 / #63）。
 *
 * 与 zhiban-wecom 的关系：本插件不直接访问企微，草稿入队、卡片推送、
 * 改稿审计都由 zhiban-wecom 通过 DSH 服务 `zhibanWecom` 提供。
 * 因此 `advisorId` 必须与 zhiban-wecom 配置里的 advisorId 一致。
 *
 * 不读取任何环境变量中的密钥；本插件没有 Secret。
 */
import type { TenantAgentSettings } from '../../src/p1/types.ts';

export interface PatientPluginConfigInput {
  tenantId?: unknown;
  workspaceRoot?: unknown;
  advisorId?: unknown;
  advisorWecomUserId?: unknown;
  advisorName?: unknown;
  agentName?: unknown;
  patientTerm?: unknown;
  tone?: unknown;
  fallbackTemplate?: unknown;
  agentPreset?: unknown;
  requireConsentForTurn?: unknown;
  demo?: unknown;
  mergeWindowMs?: unknown;
  mergeMaxWaitMs?: unknown;
  turnTimeoutMs?: unknown;
  maxProactivePerHour?: unknown;
}

export interface PatientPluginConfig {
  tenantId: string;
  workspaceRoot: string;
  agentPreset?: string;
  /** 顾问的企微 userid，用于识别机器人 1:1 改稿指令 */
  advisorWecomUserId: string;
  requireConsentForTurn: boolean;
  demo: boolean;
  settings: TenantAgentSettings;
  mergeWindowMs: number;
  mergeMaxWaitMs: number;
  turnTimeoutMs: number;
  /** #36：同一顾问每小时主动草稿上限，默认 6 */
  maxProactivePerHour: number;
}

export class PatientConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PatientConfigError';
    this.code = code;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PatientConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new PatientConfigError('CONFIG_INVALID', `${field} 必须是字符串`);
  }
  return value.trim() || undefined;
}

function boundedInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PatientConfigError('CONFIG_INVALID', `${field} 需为 ${min}–${max} 的整数`);
  }
  return value;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new PatientConfigError('CONFIG_INVALID', `${field} 必须是布尔值`);
  }
  return value;
}

export function parsePatientConfig(raw: unknown): PatientPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PatientConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as PatientPluginConfigInput;

  const advisorId = requiredString(input.advisorId, 'advisorId');
  const settings: TenantAgentSettings = {
    agentName: requiredString(input.agentName, 'agentName'),
    patientTerm: requiredString(input.patientTerm, 'patientTerm'),
    tone: optionalString(input.tone, 'tone') ?? '亲切、专业、简洁',
    advisorName: requiredString(input.advisorName, 'advisorName'),
    advisorId,
    fallbackTemplate: optionalString(input.fallbackTemplate, 'fallbackTemplate'),
  };

  return {
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceRoot: requiredString(input.workspaceRoot, 'workspaceRoot'),
    agentPreset: optionalString(input.agentPreset, 'agentPreset'),
    advisorWecomUserId: optionalString(input.advisorWecomUserId, 'advisorWecomUserId') ?? advisorId,
    requireConsentForTurn: bool(input.requireConsentForTurn, 'requireConsentForTurn', false),
    demo: bool(input.demo, 'demo', false),
    settings,
    mergeWindowMs: boundedInt(input.mergeWindowMs, 'mergeWindowMs', 1_000, 120_000, 30_000),
    mergeMaxWaitMs: boundedInt(
      input.mergeMaxWaitMs,
      'mergeMaxWaitMs',
      5_000,
      10 * 60_000,
      120_000,
    ),
    turnTimeoutMs: boundedInt(input.turnTimeoutMs, 'turnTimeoutMs', 5_000, 300_000, 15_000),
    maxProactivePerHour: boundedInt(
      input.maxProactivePerHour,
      'maxProactivePerHour',
      1,
      60,
      6,
    ),
  };
}
