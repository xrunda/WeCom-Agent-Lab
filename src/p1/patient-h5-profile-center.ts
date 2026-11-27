/**
 * PH5-10（#239）个人中心：统计口径、档案纠错与提醒偏好。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.5、§3.13；docs/PATIENT-H5-api.md §4、§10。
 *
 * 三条验收口径：
 * 1. **数字必须可复算**：陪伴天数按服务开始日算，餐食数只数有效记录，
 *    回顾天数按「有天有回顾」去重，不是记录条数
 * 2. **纠错不等于覆盖**：患者提交纠错只是把条目置为待确认 + 生成团队待办，
 *    后台处理前原事实和专业确认结论都不动
 * 3. **偏好生效到调度**：提醒开关/安静时段写进去后，提醒服务下次生成就用新值
 */
import type { FollowupService } from './patient-h5-followup.ts';
import type { ProfileEntry, ProfileService } from './patient-h5-profile.ts';
import type { PatientRecord, RecordService } from './patient-h5-record.ts';
import type { PatientReminderPrefs } from './patient-h5-reminder.ts';

export interface ProfileCenterStats {
  companionDays: number;
  mealRecords: number;
  reviewDays: number;
  /** 计算口径，前端可展示，避免「数字从哪来」说不清 */
  basis: {
    startedAt: number | null;
    mealWindowDays: number;
  };
}

export interface ReminderPrefsStore {
  load(patientId: string): PatientReminderPrefs | undefined;
  save(patientId: string, prefs: PatientReminderPrefs): Promise<void>;
}

export class MemoryReminderPrefsStore implements ReminderPrefsStore {
  private readonly items = new Map<string, PatientReminderPrefs>();

  load(patientId: string): PatientReminderPrefs | undefined {
    return this.items.get(patientId);
  }

  async save(patientId: string, prefs: PatientReminderPrefs): Promise<void> {
    this.items.set(patientId, prefs);
  }
}

export class ProfileCenterService {
  private readonly profile: ProfileService;
  private readonly records: RecordService;
  private readonly followups: FollowupService;
  private readonly prefsStore: ReminderPrefsStore;
  private readonly now: () => number;
  private readonly startedAtOf: (patientId: string) => number | null;

  constructor(options: {
    profile: ProfileService;
    records: RecordService;
    followups: FollowupService;
    prefsStore: ReminderPrefsStore;
    startedAtOf: (patientId: string) => number | null;
    now?: () => number;
  }) {
    this.profile = options.profile;
    this.records = options.records;
    this.followups = options.followups;
    this.prefsStore = options.prefsStore;
    this.startedAtOf = options.startedAtOf;
    this.now = options.now ?? Date.now;
  }

  /** 统计：全部由有效数据复算，不落冗余计数 */
  stats(patientId: string): ProfileCenterStats {
    const startedAt = this.startedAtOf(patientId);
    const now = this.now();
    const companionDays = startedAt
      ? Math.max(1, Math.floor((now - startedAt) / (24 * 60 * 60 * 1000)) + 1)
      : 0;

    const records = this.records.list(patientId);
    const mealRecords = records.filter((item) => item.kind === 'meal').length;
    const reviewDays = new Set(
      records.filter((item) => item.kind === 'evening_review').map((item) => item.occurredDate),
    ).size;

    return {
      companionDays,
      mealRecords,
      reviewDays,
      basis: { startedAt, mealWindowDays: 0 },
    };
  }

  /** 群存档里提取的餐食（只读），与 H5 自己的记录一起展示 */
  archiveMeals(patientId: string, date: string) {
    return this.records.archiveMeals(patientId, date);
  }

  /** 按日查看记录（H09 记录历史） */
  recordsOn(patientId: string, date?: string): PatientRecord[] {
    return this.records.list(patientId, date ? { date } : {});
  }

  /**
   * 档案纠错：置 disputed + 生成团队待办。
   * 专业确认条目不因患者申请而改写内容，只有团队处理后才会变。
   */
  async requestCorrection(input: {
    patientId: string;
    entryId: string;
    detail: string;
  }): Promise<{ followupId: string; entry: ProfileEntry }> {
    const entries = this.profile.list(input.patientId);
    const entry = entries.find((item) => item.id === input.entryId);
    if (!entry) throw new Error('档案条目不存在');

    const followup = await this.followups.create({
      patientId: input.patientId,
      kind: 'profile_correction',
      message: `档案纠错（${entry.fieldKey}）：${input.detail.slice(0, 300)}`,
    });

    // 只标记「待确认」，内容与来源都不动
    const updated = await this.profile.markDisputed(input.patientId, entry.id);
    return { followupId: followup.id, entry: updated };
  }

  prefs(patientId: string): PatientReminderPrefs {
    return this.prefsStore.load(patientId) ?? { enabled: false };
  }

  /**
   * 更新提醒偏好。只允许「更严格」：安静时段变长、上限变小；
   * 想放宽的请求被忽略而不是报错（患者看不出差别，但不会削弱频控）。
   */
  async updatePrefs(
    patientId: string,
    patch: Partial<PatientReminderPrefs>,
    tenantDefaults: { dailyLimit: number; quietHours: { start: string; end: string } },
  ): Promise<PatientReminderPrefs> {
    const current = this.prefs(patientId);
    const next: PatientReminderPrefs = {
      enabled: patch.enabled ?? current.enabled,
      gentleInquiry: patch.gentleInquiry ?? current.gentleInquiry ?? true,
    };

    const requestedLimit = patch.dailyLimit ?? current.dailyLimit;
    if (typeof requestedLimit === 'number' && requestedLimit >= 0) {
      next.dailyLimit = Math.min(requestedLimit, tenantDefaults.dailyLimit);
    } else if (typeof current.dailyLimit === 'number') {
      next.dailyLimit = current.dailyLimit;
    }

    const requestedQuiet = patch.quietHours ?? current.quietHours;
    if (requestedQuiet) {
      next.quietHours = stricterWindow(tenantDefaults.quietHours, requestedQuiet);
    } else if (current.quietHours) {
      next.quietHours = current.quietHours;
    }

    await this.prefsStore.save(patientId, next);
    return next;
  }
}

/** 取更长的安静时段（与提醒服务同一口径） */
export function stricterWindow(
  base: { start: string; end: string },
  candidate: { start: string; end: string },
): { start: string; end: string } {
  const toMinutes = (value: string): number => {
    const [hour, minute] = value.split(':').map(Number);
    return (hour ?? 0) * 60 + (minute ?? 0);
  };
  const span = (window: { start: string; end: string }): number => {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    return end > start ? end - start : 24 * 60 - start + end;
  };
  return span(candidate) >= span(base) ? candidate : base;
}
