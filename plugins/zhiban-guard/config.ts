/**
 * zhiban-guard 插件配置（#37）。
 *
 * 只包含租户与沙箱标记；规则与告警存在 DSH 领域表里，
 * 不读取环境变量中的任何密钥。
 */
export interface GuardPluginConfigInput {
  tenantId?: unknown;
  sandbox?: unknown;
}

export interface GuardPluginConfig {
  tenantId: string;
  /** 沙箱环境的告警带沙箱标记，便于和真实告警区分 */
  sandbox: boolean;
}

export class GuardConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GuardConfigError';
    this.code = code;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GuardConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new GuardConfigError('CONFIG_INVALID', `${field} 必须是布尔值`);
  }
  return value;
}

export function parseGuardConfig(raw: unknown): GuardPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GuardConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as GuardPluginConfigInput;
  return {
    tenantId: requiredString(input.tenantId, 'tenantId'),
    sandbox: bool(input.sandbox, 'sandbox', false),
  };
}
