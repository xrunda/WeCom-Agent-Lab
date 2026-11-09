/**
 * zhiban-care 插件配置（#36）。
 *
 * 安静时段与租户时区按机构配置；本插件没有 Secret。
 */
import type { QuietHours } from '../../src/p1/care.ts';

export interface CarePluginConfigInput {
  tenantId?: unknown;
  timeZone?: unknown;
  quietHoursStart?: unknown;
  quietHoursEnd?: unknown;
  sandbox?: unknown;
}

export interface CarePluginConfig {
  tenantId: string;
  timeZone: string;
  quietHours: QuietHours;
  sandbox: boolean;
}

export class CareConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CareConfigError';
    this.code = code;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CareConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

function hour(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new CareConfigError('CONFIG_INVALID', `${field} 需为 0–23 的整数`);
  }
  return value;
}

export function parseCareConfig(raw: unknown): CarePluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CareConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as CarePluginConfigInput;

  let timeZone = 'Asia/Shanghai';
  if (input.timeZone !== undefined) {
    timeZone = requiredString(input.timeZone, 'timeZone');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new CareConfigError('CONFIG_INVALID', `timeZone 不是有效的 IANA 时区：${timeZone}`);
    }
  }

  let sandbox = false;
  if (input.sandbox !== undefined) {
    if (typeof input.sandbox !== 'boolean') {
      throw new CareConfigError('CONFIG_INVALID', 'sandbox 必须是布尔值');
    }
    sandbox = input.sandbox;
  }

  return {
    tenantId: requiredString(input.tenantId, 'tenantId'),
    timeZone,
    quietHours: {
      start: hour(input.quietHoursStart, 'quietHoursStart', 21),
      end: hour(input.quietHoursEnd, 'quietHoursEnd', 8),
    },
    sandbox,
  };
}
