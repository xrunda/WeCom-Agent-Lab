/**
 * zhiban-patient-h5 插件配置（PH5-02 #231）。
 *
 * 配置来自 DSH 插件配置块 `zhiban-patient-h5`（config/zhiban.ts 或部署侧注入）。
 * 密钥类配置（短信凭据）不进仓库；未配置时短信模式为 unconfigured，
 * 真实登录阻塞（契约 api §2.1：不得回退到无验证码模式承载真实数据）。
 */

export type SmsMode = 'mock' | 'real' | 'unconfigured';
export type PatientLoginMode = 'invite_then_phone' | 'invite_only';

export interface PatientH5Config {
  tenantId: string;
  smsMode: SmsMode;
  patientLoginMode: PatientLoginMode;
  invitationTtlMs: number;
  sessionAbsoluteTtlMs: number;
  sessionIdleTtlMs: number;
  verifyCodeTtlMs: number;
  consentTextsVersion: number;
  retentionNotice: string;
  /** H5 前端来源（Origin 校验白名单）；空数组 = 只允许同源 */
  allowedOrigins: string[];
}

interface RawConfig {
  tenantId?: unknown;
  sms?: unknown;
  patientLoginMode?: unknown;
  invitationTtlHours?: unknown;
  sessionAbsoluteTtlDays?: unknown;
  sessionIdleTtlHours?: unknown;
  verifyCodeTtlMinutes?: unknown;
  consentTextsVersion?: unknown;
  retentionNotice?: unknown;
  allowedOrigins?: unknown;
}

const DEFAULTS = {
  invitationTtlMs: 24 * 60 * 60 * 1000,
  sessionAbsoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  sessionIdleTtlMs: 24 * 60 * 60 * 1000,
  verifyCodeTtlMs: 5 * 60 * 1000,
} as const;

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function parsePatientH5Config(raw: unknown): PatientH5Config {
  const input = (raw ?? {}) as RawConfig;
  if (typeof input.tenantId !== 'string' || !input.tenantId) {
    throw new Error('[zhiban-patient-h5] 缺少 tenantId 配置');
  }
  const smsRaw = input.sms;
  let smsMode: SmsMode = 'unconfigured';
  if (smsRaw === 'mock' || (smsRaw && typeof smsRaw === 'object')) {
    // 真实短信供应商尚未接入（待决项 #229）：配置对象先按 unconfigured 处理，
    // 只有显式 'mock' 才启用演示渠道。
    smsMode = smsRaw === 'mock' ? 'mock' : 'unconfigured';
  }
  const loginModeRaw = input.patientLoginMode;
  const patientLoginMode: PatientLoginMode =
    loginModeRaw === 'invite_only' ? 'invite_only' : 'invite_then_phone';
  return {
    tenantId: input.tenantId,
    smsMode,
    patientLoginMode,
    invitationTtlMs:
      typeof input.invitationTtlHours === 'number'
        ? positiveInt(input.invitationTtlHours, 24) * 60 * 60 * 1000
        : DEFAULTS.invitationTtlMs,
    sessionAbsoluteTtlMs:
      typeof input.sessionAbsoluteTtlDays === 'number'
        ? positiveInt(input.sessionAbsoluteTtlDays, 7) * 24 * 60 * 60 * 1000
        : DEFAULTS.sessionAbsoluteTtlMs,
    sessionIdleTtlMs:
      typeof input.sessionIdleTtlHours === 'number'
        ? positiveInt(input.sessionIdleTtlHours, 24) * 60 * 60 * 1000
        : DEFAULTS.sessionIdleTtlMs,
    verifyCodeTtlMs:
      typeof input.verifyCodeTtlMinutes === 'number'
        ? positiveInt(input.verifyCodeTtlMinutes, 5) * 60 * 1000
        : DEFAULTS.verifyCodeTtlMs,
    consentTextsVersion: positiveInt(input.consentTextsVersion, 1),
    retentionNotice:
      typeof input.retentionNotice === 'string' && input.retentionNotice
        ? input.retentionNotice.slice(0, 200)
        : '按合同约定；当前演示环境不自动删除',
    allowedOrigins: Array.isArray(input.allowedOrigins)
      ? input.allowedOrigins.filter((item): item is string => typeof item === 'string')
      : [],
  };
}
