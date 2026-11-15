/**
 * zhiban-console 插件配置。
 *
 * 账号口令只放在 DSH profile（部署机）里，不进仓库；插件启动时哈希后写领域库。
 * 本地用 HTTP 调试时把 cookieSecure 设为 false，生产必须 true（HTTPS）。
 */
import { validatePassword } from '../../src/p1/console-auth.ts';
import {
  DEFAULT_TENANT_SETTINGS,
  isValidPatientTerm,
  PATIENT_TERM_MAX_LENGTH,
  type PatientTerm,
  type TenantSettings,
} from '../../src/p1/console-types.ts';

export interface SeedAccountConfig {
  username: string;
  displayName: string;
  password: string;
}

/**
 * #181 企微扫码登录。四项齐全才启用；缺任何一项时登录页不展示入口，
 * 密码登录不受影响（企微 Secret 轮换 / 可见范围误改时的兜底）。
 */
export interface WecomLoginConfig {
  corpId: string;
  /** 自建应用 AgentId（知伴顾问助手）；不是智能机器人 Bot ID */
  agentId: string;
  agentSecret: string;
  /** 控制台公网地址，如 https://zhiban.example.com；用于拼回调 */
  publicBaseUrl: string;
  /** 扫码会话有效期，默认 8 小时 */
  sessionTtlMs: number;
}

/** 扫码会话默认 8 小时：比密码登录短，成员异动最多隔夜失效 */
export const WECOM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * 密码登录数字验证码。默认开启；只有明确配置 `captcha.enabled: false`
 * 才关闭（自动化测试、内网离线调试），生产环境不要关闭。
 */
export interface CaptchaConfig {
  enabled: boolean;
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
  /** #181：不配置则只能密码登录 */
  wecom?: WecomLoginConfig;
  captcha: CaptchaConfig;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionTtlMs: number;
  sandbox: {
    mediaRootDir: string;
    dailyLimit: number;
  };
  /** 部署事实，用于「数据与安全」页；不填时按境内部署的默认口径展示 */
  deployment: {
    region: string;
    modelRegion: string;
    modelService: string;
  };
  /** 服务端 PDF 字体；不填时按环境变量与常见系统字体查找 */
  pdf: {
    fontPath?: string;
    fontFamily?: string;
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

/** 公网地址只接受 http/https，去掉末尾斜杠；回调地址在此基础上拼接 */
function parseBaseUrl(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} 必须是完整 URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${field} 只支持 http/https`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * #181 扫码登录配置。凭据只来自 DSH profile，不写进仓库；
 * 报错只带字段名，绝不回显 Secret 值。
 */
function parseWecom(raw: unknown): WecomLoginConfig | undefined {
  if (raw === undefined) return undefined;
  const object = asObject(raw);
  const ttl = object.sessionTtlMs;
  if (ttl !== undefined && (typeof ttl !== 'number' || ttl <= 0)) {
    throw new Error('wecom.sessionTtlMs 必须是正数');
  }
  return {
    corpId: requireString(object.corpId, 'wecom.corpId'),
    agentId: requireString(object.agentId, 'wecom.agentId'),
    agentSecret: requireString(object.agentSecret, 'wecom.agentSecret'),
    publicBaseUrl: parseBaseUrl(object.publicBaseUrl, 'wecom.publicBaseUrl'),
    sessionTtlMs: typeof ttl === 'number' ? ttl : WECOM_SESSION_TTL_MS,
  };
}

function parseCaptcha(raw: unknown): CaptchaConfig {
  if (raw === undefined) return { enabled: true };
  const object = asObject(raw);
  if (object.enabled !== undefined && typeof object.enabled !== 'boolean') {
    throw new Error('captcha.enabled 必须是布尔值');
  }
  return { enabled: object.enabled !== false };
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
  const patientTermRaw = optionalString(tenantRaw.patientTerm, '患者').trim();
  if (!isValidPatientTerm(patientTermRaw)) {
    throw new Error(`tenant.patientTerm 必须是 1–${PATIENT_TERM_MAX_LENGTH} 个字符`);
  }
  const allowedOriginsRaw = object.allowedOrigins;
  if (
    allowedOriginsRaw !== undefined &&
    (!Array.isArray(allowedOriginsRaw) || allowedOriginsRaw.some((item) => typeof item !== 'string'))
  ) {
    throw new Error('allowedOrigins 必须是字符串数组');
  }
  const sandboxRaw = object.sandbox === undefined ? {} : asObject(object.sandbox);
  const deploymentRaw = object.deployment === undefined ? {} : asObject(object.deployment);
  const pdfRaw = object.pdf === undefined ? {} : asObject(object.pdf);
  const sessionTtlRaw = object.sessionTtlMs;
  if (sessionTtlRaw !== undefined && (typeof sessionTtlRaw !== 'number' || sessionTtlRaw <= 0)) {
    throw new Error('sessionTtlMs 必须是正数');
  }
  if (typeof object.cookieSecure === 'boolean' && object.cookieSecure === false) {
    // 本地调试允许；生产必须 HTTPS
  } else if (object.cookieSecure !== undefined && typeof object.cookieSecure !== 'boolean') {
    throw new Error('cookieSecure 必须是布尔值');
  }
  const wecom = parseWecom(object.wecom);

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
    ...(wecom ? { wecom } : {}),
    captcha: parseCaptcha(object.captcha),
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
    deployment: {
      region: optionalString(deploymentRaw.region, '中国大陆境内'),
      modelRegion: optionalString(deploymentRaw.modelRegion, '中国大陆境内'),
      modelService: optionalString(deploymentRaw.modelService, 'DeepSeek（境内）'),
    },
    pdf: {
      fontPath: optionalString(pdfRaw.fontPath, '') || undefined,
      fontFamily: optionalString(pdfRaw.fontFamily, '') || undefined,
    },
  };
}
