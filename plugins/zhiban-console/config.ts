/**
 * zhiban-console 插件配置。
 *
 * 账号口令只放在 DSH profile（部署机）里，不进仓库；插件启动时哈希后写领域库。
 * 本地用 HTTP 调试时把 cookieSecure 设为 false，生产必须 true（HTTPS）。
 */
import { validatePassword } from '../../src/p1/console-auth.ts';
import {
  DEFAULT_TENANT_SETTINGS,
  PATIENT_TERMS,
  type PatientTerm,
  type TenantSettings,
} from '../../src/p1/console-types.ts';

export interface SeedAccountConfig {
  username: string;
  displayName: string;
  password: string;
}

export interface ConsoleConfig {
  tenantId: string;
  tenant: {
    name: string;
    agentName: string;
    agentAvatar: string | null;
    patientTerm: PatientTerm;
    tone: string;
    timezone: string;
    settings: TenantSettings;
  };
  admin: SeedAccountConfig;
  platform?: SeedAccountConfig;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionTtlMs: number;
  sandbox: {
    mediaRootDir: string;
    dailyLimit: number;
  };
}

const DEFAULT_TONE = '亲切、专业、简洁，不超过 150 字';
const USERNAME_MAX = 64;

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('插件配置必须是对象');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少配置项 ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function parseAccount(raw: unknown, field: string): SeedAccountConfig {
  const object = asObject(raw);
  const username = requireString(object.username, `${field}.username`);
  if (username.length > USERNAME_MAX) {
    throw new Error(`${field}.username 不能超过 ${USERNAME_MAX} 字符`);
  }
  const password = requireString(object.password, `${field}.password`);
  const issue = validatePassword(password);
  if (issue) throw new Error(`${field}.password 不合法：${issue}`);
  return {
    username,
    displayName: optionalString(object.displayName, username),
    password,
  };
}

function parseSettings(raw: unknown): TenantSettings {
  if (raw === undefined) return { ...DEFAULT_TENANT_SETTINGS, quietHours: { ...DEFAULT_TENANT_SETTINGS.quietHours } };
  const object = asObject(raw);
  const settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    quietHours: { ...DEFAULT_TENANT_SETTINGS.quietHours },
  };
  if (object.archiveSeatPriceYuan !== undefined) {
    if (typeof object.archiveSeatPriceYuan !== 'number' || object.archiveSeatPriceYuan < 0) {
      throw new Error('tenant.settings.archiveSeatPriceYuan 必须是非负数');
    }
    settings.archiveSeatPriceYuan = object.archiveSeatPriceYuan;
  }
  return settings;
}

export function parseConsoleConfig(raw: unknown): ConsoleConfig {
  const object = asObject(raw);
  const tenantId = requireString(object.tenantId, 'tenantId');
  const tenantRaw = object.tenant === undefined ? {} : asObject(object.tenant);
  const patientTermRaw = optionalString(tenantRaw.patientTerm, '患者');
  if (!PATIENT_TERMS.includes(patientTermRaw as PatientTerm)) {
    throw new Error('tenant.patientTerm 只能是「患者 / 客户 / 会员」');
  }
  const allowedOriginsRaw = object.allowedOrigins;
  if (
    allowedOriginsRaw !== undefined &&
    (!Array.isArray(allowedOriginsRaw) || allowedOriginsRaw.some((item) => typeof item !== 'string'))
  ) {
    throw new Error('allowedOrigins 必须是字符串数组');
  }
  const sandboxRaw = object.sandbox === undefined ? {} : asObject(object.sandbox);
  const sessionTtlRaw = object.sessionTtlMs;
  if (sessionTtlRaw !== undefined && (typeof sessionTtlRaw !== 'number' || sessionTtlRaw <= 0)) {
    throw new Error('sessionTtlMs 必须是正数');
  }
  if (typeof object.cookieSecure === 'boolean' && object.cookieSecure === false) {
    // 本地调试允许；生产必须 HTTPS
  } else if (object.cookieSecure !== undefined && typeof object.cookieSecure !== 'boolean') {
    throw new Error('cookieSecure 必须是布尔值');
  }

  return {
    tenantId,
    tenant: {
      name: optionalString(tenantRaw.name, '知伴健康管理中心'),
      agentName: optionalString(tenantRaw.agentName, '小安'),
      agentAvatar:
        typeof tenantRaw.agentAvatar === 'string' && tenantRaw.agentAvatar.trim() !== ''
          ? tenantRaw.agentAvatar.trim()
          : null,
      patientTerm: patientTermRaw as PatientTerm,
      tone: optionalString(tenantRaw.tone, DEFAULT_TONE),
      timezone: optionalString(tenantRaw.timezone, 'Asia/Shanghai'),
      settings: parseSettings(tenantRaw.settings),
    },
    admin: parseAccount(object.admin, 'admin'),
    platform: object.platform === undefined ? undefined : parseAccount(object.platform, 'platform'),
    cookieSecure: object.cookieSecure !== false,
    allowedOrigins: (allowedOriginsRaw as string[] | undefined) ?? [],
    sessionTtlMs:
      typeof sessionTtlRaw === 'number' ? sessionTtlRaw : 7 * 24 * 60 * 60 * 1000,
    sandbox: {
      mediaRootDir: optionalString(sandboxRaw.mediaRootDir, ''),
      dailyLimit:
        typeof sandboxRaw.dailyLimit === 'number' && sandboxRaw.dailyLimit > 0
          ? Math.floor(sandboxRaw.dailyLimit)
          : 100,
    },
  };
}
