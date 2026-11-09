/**
 * zhiban-memory 插件配置（#35）。
 *
 * 本插件没有 Secret；租户与注入上限来自 DSH profile 的插件配置。
 */
export interface MemoryPluginConfigInput {
  tenantId?: unknown;
  sandbox?: unknown;
  injectLimit?: unknown;
}

export interface MemoryPluginConfig {
  tenantId: string;
  sandbox: boolean;
  injectLimit: number;
}

export class MemoryConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryConfigError';
    this.code = code;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

export function parseMemoryConfig(raw: unknown): MemoryPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemoryConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as MemoryPluginConfigInput;

  let sandbox = false;
  if (input.sandbox !== undefined) {
    if (typeof input.sandbox !== 'boolean') {
      throw new MemoryConfigError('CONFIG_INVALID', 'sandbox 必须是布尔值');
    }
    sandbox = input.sandbox;
  }

  let injectLimit = 30;
  if (input.injectLimit !== undefined) {
    if (
      typeof input.injectLimit !== 'number' ||
      !Number.isInteger(input.injectLimit) ||
      input.injectLimit < 1 ||
      input.injectLimit > 200
    ) {
      throw new MemoryConfigError('CONFIG_INVALID', 'injectLimit 需为 1–200 的整数');
    }
    injectLimit = input.injectLimit;
  }

  return { tenantId: requiredString(input.tenantId, 'tenantId'), sandbox, injectLimit };
}
