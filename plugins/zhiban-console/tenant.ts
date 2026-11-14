/**
 * #41 租户与运营参数校验（P1-api.md §3 / P1-data-model.md §3.1）。
 *
 * `agentName` / `patientTerm` / `tone` 保存后由 index.ts 同步给患者运行时，
 * 下一轮 Agent 回合即生效；`modelName` 只读回显，不接受 PATCH。
 */
import { ConsoleError } from '../../src/p1/console-error.ts';
import {
  DEFAULT_TENANT_SETTINGS,
  isValidPatientTerm,
  PATIENT_TERM_MAX_LENGTH,
  type PatientTerm,
  type TenantRecord,
  type TenantSettings,
} from '../../src/p1/console-types.ts';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface TenantPatch {
  name?: string;
  agentName?: string;
  agentAvatar?: string | null;
  patientTerm?: PatientTerm;
  tone?: string;
  timezone?: string;
  settings?: Partial<TenantSettings>;
}

function fail(field: string, issue: string): never {
  throw new ConsoleError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') fail(field, '必须是字符串');
  const clean = value.trim();
  if (!allowEmpty && clean === '') fail(field, '不能为空');
  if (clean.length > max) fail(field, `不能超过 ${max} 字`);
  return clean;
}

export function validateTenantPatch(raw: unknown, existing: TenantRecord): TenantPatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('body', '必须是对象');
  }
  const input = raw as Record<string, unknown>;
  const patch: TenantPatch = {};

  if (input.name !== undefined) patch.name = text(input.name, 'name', 100);
  if (input.agentName !== undefined) patch.agentName = text(input.agentName, 'agentName', 40);
  if (input.tone !== undefined) patch.tone = text(input.tone, 'tone', 500);
  if (input.timezone !== undefined) {
    const timezone = text(input.timezone, 'timezone', 64);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      fail('timezone', '不是合法的 IANA 时区');
    }
    patch.timezone = timezone;
  }
  if (input.agentAvatar !== undefined) {
    if (input.agentAvatar === null) patch.agentAvatar = null;
    else patch.agentAvatar = text(input.agentAvatar, 'agentAvatar', 500);
  }
  if (input.patientTerm !== undefined) {
    if (typeof input.patientTerm !== 'string') fail('patientTerm', '必须是字符串');
    const term = input.patientTerm.trim();
    if (!isValidPatientTerm(term)) {
      fail('patientTerm', `必须是 1–${PATIENT_TERM_MAX_LENGTH} 个字符，不能只含空白`);
    }
    patch.patientTerm = term;
  }

  if (input.settings !== undefined) {
    if (input.settings === null || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
      fail('settings', '必须是对象');
    }
    const rawSettings = input.settings as Record<string, unknown>;
    const settings: Partial<TenantSettings> = {};
    if (rawSettings.archiveSeatPriceYuan !== undefined) {
      const value = rawSettings.archiveSeatPriceYuan;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail('settings.archiveSeatPriceYuan', '必须是非负数');
      }
      settings.archiveSeatPriceYuan = value;
    }
    if (rawSettings.writeMinutesPerDraft !== undefined) {
      const value = rawSettings.writeMinutesPerDraft;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 30) {
        fail('settings.writeMinutesPerDraft', '必须是 1–30 的整数');
      }
      settings.writeMinutesPerDraft = value;
    }
    if (rawSettings.mergeWindowSeconds !== undefined) {
      const value = rawSettings.mergeWindowSeconds;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 300) {
        fail('settings.mergeWindowSeconds', '必须是 0–300 的整数');
      }
      settings.mergeWindowSeconds = value;
    }
    if (rawSettings.proactivePerHour !== undefined) {
      const value = rawSettings.proactivePerHour;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
        fail('settings.proactivePerHour', '必须是 1–100 的整数');
      }
      settings.proactivePerHour = value;
    }
    if (rawSettings.memoryInjectLimit !== undefined) {
      const value = rawSettings.memoryInjectLimit;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) {
        fail('settings.memoryInjectLimit', '必须是 1–200 的整数');
      }
      settings.memoryInjectLimit = value;
    }
    if (rawSettings.retentionNotice !== undefined) {
      settings.retentionNotice = text(rawSettings.retentionNotice, 'settings.retentionNotice', 200);
    }
    if (rawSettings.quietHours !== undefined) {
      const quiet = rawSettings.quietHours;
      if (quiet === null || typeof quiet !== 'object' || Array.isArray(quiet)) {
        fail('settings.quietHours', '必须是 { start, end }');
      }
      const start = (quiet as Record<string, unknown>).start;
      const end = (quiet as Record<string, unknown>).end;
      if (typeof start !== 'string' || !TIME_RE.test(start)) fail('settings.quietHours.start', '必须是 HH:mm');
      if (typeof end !== 'string' || !TIME_RE.test(end)) fail('settings.quietHours.end', '必须是 HH:mm');
      settings.quietHours = { start, end };
    }
    // modelName 只读回显，忽略客户端传值
    patch.settings = settings;
  }

  void existing;
  return patch;
}

export function applyTenantPatch(
  existing: TenantRecord,
  patch: TenantPatch,
  now: number,
): TenantRecord {
  const settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    ...existing.settings,
    ...(patch.settings ?? {}),
    quietHours: {
      ...existing.settings.quietHours,
      ...(patch.settings?.quietHours ?? {}),
    },
    modelName: existing.settings.modelName,
  };
  return {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.agentName !== undefined ? { agentName: patch.agentName } : {}),
    ...(patch.agentAvatar !== undefined ? { agentAvatar: patch.agentAvatar } : {}),
    ...(patch.patientTerm !== undefined ? { patientTerm: patch.patientTerm } : {}),
    ...(patch.tone !== undefined ? { tone: patch.tone } : {}),
    ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
    settings,
    updatedAt: now,
  };
}

/** 对外 tenant：字段与 P1-data-model §3.1 一致 */
export function publicTenant(record: TenantRecord): TenantRecord {
  return { ...record, settings: { ...record.settings, quietHours: { ...record.settings.quietHours } } };
}
