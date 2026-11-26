/**
 * zhiban-patient-h5 插件（PH5-02 #231）。
 *
 * 患者端 H5 的身份、邀请、会话、分项授权与隐私申请服务。
 * - HTTP 挂在 `/zhiban/h5` 前缀（患者接口，独立 Cookie）
 * - 患者档案只读视图来自 `zhibanPatient`（顾问名册与患者状态），不重复建档
 * - 团队端接口由 plugins/zhiban-console/routes/ph5-invitations.ts 经
 *   `zhibanPatientH5` 调用（契约 api §12）
 *
 * 真实短信供应商未接入前 smsMode=unconfigured，真实登录阻塞（#229 待决项）；
 * smsMode=mock 仅限开发/测试，验证码固定 000000（契约 api §15）。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { idFactory } from '../../src/p1/ids.ts';
import {
  MemoryH5Backend,
  MOCK_SMS,
  PatientH5Service,
  UNCONFIGURED_SMS,
} from '../../src/p1/patient-h5.ts';
import type {
  ConsentScope,
  ConsentStatus,
  H5AuditRecord,
  H5BindingRecord,
  H5SessionRecord,
  InvitationRecord,
  PatientH5Backend,
  PrivacyRequestRecord,
  PrivacyRequestStatus,
} from '../../src/p1/patient-h5.ts';
import { MemoryProfileBackend, ProfileService } from '../../src/p1/patient-h5-profile.ts';
import type { ProfileBackend } from '../../src/p1/patient-h5-profile.ts';
import {
  MemoryPlanBackend,
  PlanService,
  UNCONFIGURED_GENERATOR,
} from '../../src/p1/patient-h5-plan.ts';
import type { HealthPlanRecord } from '../../src/p1/patient-h5-plan.ts';
import { parsePatientH5Config } from './config.ts';
import type { PatientH5Config } from './config.ts';
import { DomainPatientH5Backend, patientH5Domain } from './domain.ts';
import { registerPatientH5Http } from './http.ts';
import type { H5HttpRequest, H5HttpResponse } from './http.ts';
import { createProfileRoutes, DomainProfileBackend } from './routes/profile.ts';
import type { ManifestoConfig } from './routes/profile.ts';
import { createPlanRoutes, DomainPlanBackend } from './routes/plan.ts';
import { createCalendarRoutes } from './routes/calendar.ts';
import { createRecordRoutes, DomainRecordBackend, MemoryMediaStore } from './routes/records.ts';
import { createFollowupRoutes } from './routes/followup.ts';
import { createContentRoutes } from './routes/content.ts';
import { ContentService, MemoryContentBackend } from '../../src/p1/patient-h5-content.ts';
import { FollowupService, MemoryFollowupBackend } from '../../src/p1/patient-h5-followup.ts';
import { MemoryReminderBackend, ReminderService } from '../../src/p1/patient-h5-reminder.ts';
import { createProfileCenterRoutes } from './routes/profile-center.ts';
import {
  MemoryReminderPrefsStore,
  ProfileCenterService,
} from '../../src/p1/patient-h5-profile-center.ts';
import { MemoryRecordBackend, RecordService, UNCONFIGURED_RECOGNITION } from '../../src/p1/patient-h5-record.ts';
import { CalendarService } from '../../src/p1/patient-h5-calendar.ts';
import { buildPlanTool, DshPlanSessionPort } from './plan-session.ts';
import type { PlanSessionControllerLike } from './plan-session.ts';
import { LlmPlanGenerator } from '../../src/p1/patient-h5-plan-ai.ts';
import type { PlanChatPort } from '../../src/p1/patient-h5-plan-ai.ts';

interface AnyTableLike {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

export const name = 'zhiban-patient-h5';

export const inject = ['storageDomain', 'webServer', 'tools', 'sessionController'];

export interface DshPatientH5Context {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => void | Promise<void>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  get<T = unknown>(name: string): T | undefined;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: H5HttpRequest, res: H5HttpResponse) => unknown;
    }): unknown;
  };
  /** 宿主工具注册表（方案生成必须经工具回传，见 P1-M0-dsh-validation §1.2） */
  tools?: {
    register(tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: (args: unknown, exec: { agent?: { id?: string } }) => Promise<unknown>;
    }): unknown;
  };
  sessionController?: PlanSessionControllerLike;
}

/** 患者档案只读视图（来自 zhiban-patient） */
interface PatientViewLike {
  id: string;
  displayName: string;
  status: string;
  advisorId?: string;
  /** 服务开始时间（P1 patient.accompaniedSince）；没有时用绑定时间兜底 */
  accompaniedSince?: number;
}

interface PatientApiLike {
  getPatientAdmin?(id: string): PatientViewLike | undefined;
}

/** 暴露给控制台团队端路由的 API（契约 api §12.1/§12.7/§12.8） */
export interface PatientH5RuntimeApi {
  config: PatientH5Config;
  createInvitation(input: {
    patientId: string;
    phone: string;
    ttlHours?: number;
    note?: string;
    createdBy: string;
  }): Promise<InvitationRecord>;
  listInvitations(patientId: string): InvitationRecord[];
  invitationView(record: InvitationRecord): Omit<InvitationRecord, 'code' | 'phone'>;
  revokeInvitation(id: string, revokedBy: string): Promise<InvitationRecord>;
  getBinding(patientId: string): H5BindingRecord | undefined;
  listSessions(patientId: string): H5SessionRecord[];
  revokeSession(sessionId: string, by: 'account', accountId: string): Promise<void>;
  consentsView(patientId: string): Record<string, ConsentStatus>;
  consentStatus(patientId: string, scope: ConsentScope): ConsentStatus;
  listPrivacyRequests(status?: PrivacyRequestStatus): PrivacyRequestRecord[];
  handlePrivacyRequest(input: {
    id: string;
    result: 'handled' | 'rejected';
    note: string;
    handledBy: string;
  }): Promise<PrivacyRequestRecord>;
  meStatus(patientId: string): string;
  /** 供控制台展示邀请链接（一次性返回，不落日志；列表不再回 code） */
  /** 邀请链接（域名来自服务端配置，不接受调用方传入，防钓鱼域名注入） */
  invitationLink(record: InvitationRecord): string;
}

/** 暴露给控制台团队端（契约 api §12.2） */
export interface PatientH5PlanApi {
  list(patientId: string): HealthPlanRecord[];
  get(id: string): HealthPlanRecord | undefined;
  generate(input: {
    patientId: string;
    startDate: string;
    endDate: string;
    actorId: string;
  }): Promise<HealthPlanRecord>;
  createManualDraft(input: {
    patientId: string;
    startDate: string;
    endDate: string;
    actorId: string;
    stageGoal?: string;
  }): Promise<HealthPlanRecord>;
  update(input: {
    planId: string;
    actorId: string;
    expectedVersion: number;
    patch: Record<string, unknown>;
  }): Promise<HealthPlanRecord>;
  reject(input: {
    planId: string;
    actorId: string;
    actorName: string;
    note: string;
  }): Promise<HealthPlanRecord>;
  publish(input: {
    planId: string;
    actorId: string;
    actorName: string;
    note?: string;
  }): Promise<HealthPlanRecord>;
  suspend(input: { planId: string; actorId: string }): Promise<HealthPlanRecord>;
  resume(input: { planId: string; actorId: string }): Promise<HealthPlanRecord>;
  end(input: { planId: string; actorId: string }): Promise<HealthPlanRecord>;
}

const DEFAULT_H5_PUBLIC_BASE = 'https://h5.example.invalid';

export function apply(ctx: DshPatientH5Context, rawConfig: unknown): void {
  const config = parsePatientH5Config(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-patient-h5] ${line}`);

  log(
    `加载配置：租户=${config.tenantId} 短信=${config.smsMode} ` +
      `登录模式=${config.patientLoginMode}`,
  );

  const sms =
    config.smsMode === 'mock'
      ? MOCK_SMS
      : UNCONFIGURED_SMS;
  if (config.smsMode !== 'mock') {
    log('短信通道未配置：真实登录阻塞（SMS_UNAVAILABLE），演示只能用虚构数据');
  }

  // 患者视图懒加载：zhiban-patient 晚于本插件就绪也能查
  const patientView = (patientId: string): PatientViewLike | undefined => {
    const api = ctx.get<PatientApiLike>('zhibanPatient');
    const patient = api?.getPatientAdmin?.(patientId);
    if (!patient) return undefined;
    return {
      id: patient.id,
      displayName: patient.displayName,
      status: patient.status,
      ...(patient.advisorId ? { advisorId: patient.advisorId } : {}),
      ...(patient.accompaniedSince ? { accompaniedSince: patient.accompaniedSince } : {}),
    };
  };

  ctx.effect(async () => {
    let backend: PatientH5Backend;
    let profileTable: AnyTableLike | undefined;
    let idempotencyTable: AnyTableLike | undefined;
    let planTable: AnyTableLike | undefined;
    let calendarTable: AnyTableLike | undefined;
    let followupTable: AnyTableLike | undefined;
    let recordTable: AnyTableLike | undefined;
    let mediaTable: AnyTableLike | undefined;
    let reminderTable: AnyTableLike | undefined;
    let contentTable: AnyTableLike | undefined;
    try {
      const domain = await ctx.storageDomain.open(patientH5Domain);
      backend = new DomainPatientH5Backend(domain, config.tenantId);
      profileTable = domain.table('patient_profile_entries') as unknown as AnyTableLike;
      idempotencyTable = domain.table('idempotency_records') as unknown as AnyTableLike;
      planTable = domain.table('health_plans') as unknown as AnyTableLike;
      calendarTable = domain.table('calendar_items') as unknown as AnyTableLike;
      followupTable = domain.table('followup_requests') as unknown as AnyTableLike;
      recordTable = domain.table('patient_records') as unknown as AnyTableLike;
      mediaTable = domain.table('h5_media') as unknown as AnyTableLike;
      reminderTable = domain.table('reminder_tasks') as unknown as AnyTableLike;
      contentTable = domain.table('content_articles') as unknown as AnyTableLike;
    } catch (error) {
      // 存储域不可用（如测试环境）：退回内存后端，并告警
      ctx.logger?.warn?.(
        `[zhiban-patient-h5] 领域存储打开失败，退回内存后端：${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      backend = new MemoryH5Backend();
    }

    const service = new PatientH5Service({
      tenantId: config.tenantId,
      backend,
      sms,
      loadPatient: patientView,
      ids: idFactory(Date.now),
      invitationTtlMs: config.invitationTtlMs,
      sessionAbsoluteTtlMs: config.sessionAbsoluteTtlMs,
      sessionIdleTtlMs: config.sessionIdleTtlMs,
      verifyCodeTtlMs: config.verifyCodeTtlMs,
      patientLoginMode: config.patientLoginMode,
      consentTextsVersion: config.consentTextsVersion,
      retentionNotice: config.retentionNotice,
      onConsentChange: (patientId, scope, status) => {
        // 取消传播钩子（契约 §5）：PH5-09 提醒包接入后在此取消未发出提醒
        ctx.emit('h5.consent.change', { patientId, scope, status, at: Date.now() });
        if (scope === 'reminder' && status === 'withdrawn') {
          void reminders.cancelForPlan(patientId, { reason: 'consent_withdrawn' }).catch(() => undefined);
        }
      },
      onAudit: (record: H5AuditRecord) => {
        ctx.emit('h5.audit', record);
      },
    });

    const api: PatientH5RuntimeApi = {
      config,
      createInvitation: (input) =>
        service.createInvitation({
          ...input,
          advisorId: patientView(input.patientId)?.advisorId ?? 'unknown',
        }),
      listInvitations: (patientId) => service.listInvitations(patientId),
      invitationView: (record) => service.invitationView(record),
      revokeInvitation: (id, revokedBy) => service.revokeInvitation(id, revokedBy),
      getBinding: (patientId) => service.getBinding(patientId),
      listSessions: (patientId) => service.listSessions(patientId),
      revokeSession: (sessionId, _by, accountId) =>
        service.revokeSession(sessionId, 'account', accountId),
      consentsView: (patientId) => service.consentsView(patientId),
      consentStatus: (patientId, scope) => service.consentStatus(patientId, scope),
      listPrivacyRequests: (status) => service.listPrivacyRequests(status),
      handlePrivacyRequest: (input) => service.handlePrivacyRequest(input),
      meStatus: (patientId) => {
        const patient = patientView(patientId);
        return patient ? service.meStatus(patient) : 'service_paused';
      },
      invitationLink: (record) =>
        `${config.publicBaseUrl ?? DEFAULT_H5_PUBLIC_BASE}/h5/invite?code=${encodeURIComponent(record.code)}`,
    };
    ctx.provide('zhibanPatientH5', api);

    if (!config.publicBaseUrl) {
      log('未配置 publicBaseUrl：邀请链接会指向占位域名，真实发放前必须在配置中登记 H5 站点地址');
    }
    if (!config.cookieSecure) {
      log('警告：cookieSecure=false，会话 Cookie 允许明文传输；仅限本地开发，生产必须为 true');
    }


    // PH5-03（#232）：轻量建档域路由 + 食养主张（公开）
    // 域存储不可用时退回内存实现（进程内有效，仅限开发/测试）
    const profileBackend: ProfileBackend = profileTable
      ? new DomainProfileBackend(profileTable, config.tenantId, idempotencyTable)
      : new MemoryProfileBackend();
    const profile = new ProfileService({
      backend: profileBackend,
      tenantId: config.tenantId,
      ids: idFactory(Date.now),
    });
    // PH5-04（#233）：方案生成与审核发布。模型未接入时生成进入 generate_failed，
    // 由团队人工接管（不把模板伪装成个性化方案）。
    const planBackend =
      planTable && calendarTable
        ? new DomainPlanBackend(planTable, calendarTable, config.tenantId)
        : new MemoryPlanBackend();
    let chatPort: PlanChatPort | undefined;
    if (ctx.sessionController && ctx.tools) {
      const sessionPort = new DshPlanSessionPort({
        sessionController: ctx.sessionController,
        workspaceRoot: config.planWorkspaceRoot ?? join(tmpdir(), 'zhiban-plan'),
        ...(config.planAgentPreset ? { agentPreset: config.planAgentPreset } : {}),
        log,
      });
      ctx.tools.register(buildPlanTool(sessionPort));
      chatPort = sessionPort;
      log('方案生成已接入模型（submit_health_plan 工具已注册）');
    } else {
      log('未提供 sessionController / tools：方案生成保持未接入，只能由团队人工起草');
    }

    const plan = new PlanService({
      tenantId: config.tenantId,
      backend: planBackend,
      generator: chatPort
        ? new LlmPlanGenerator({ port: chatPort, modelName: config.planModelName })
        : UNCONFIGURED_GENERATOR,
      profile,
      ids: idFactory(Date.now),
      onAudit: (event) => ctx.emit('h5.audit', event),
      onPlanEvent: (event) => {
        ctx.emit('h5.plan.event', event);
        // 换版/暂停/结束：撤销未发出的提醒（发送前还会再复查一次）
        const reason =
          event.type === 'published'
            ? 'plan_superseded'
            : event.type === 'suspended'
              ? 'plan_suspended'
              : event.type === 'ended'
                ? 'plan_ended'
                : 'plan_superseded';
        void reminders
          .cancelForPlan(event.patientId, {
            reason: reason as never,
            ...(event.cancelledItemIds.length ? { itemIds: event.cancelledItemIds } : {}),
          })
          .catch(() => undefined);
      },
    });
    // PH5-07：跟进请求统一由 FollowupService 管理（认领、SLA、升级）
    const followupBackend = followupTable
      ? {
          load: () =>
            [...followupTable!.entries()]
              .map(([, value]) => value as never)
              .filter((item) => (item as { tenantId?: string }).tenantId === config.tenantId),
          put: (record: { id: string }) => followupTable!.put(record.id, record),
        }
      : new MemoryFollowupBackend();
    const followups = new FollowupService({
      tenantId: config.tenantId,
      backend: followupBackend as never,
      ids: idFactory(Date.now),
      ...(config.supervisorAccountId
        ? { supervisorAccountId: config.supervisorAccountId }
        : {}),
      onAudit: (event) => ctx.emit('h5.followup.audit', event),
    });
    /** 兼容旧调用点：把历史写法收敛到统一服务 */
    const adjust = {
      put: async (record: Record<string, unknown>) => {
        await followups.create({
          patientId: String(record.patientId),
          kind: (record.kind as never) ?? 'question',
          message: String(record.message ?? ''),
          ...(typeof record.linkedPlanId === 'string' && record.linkedPlanId
            ? { linkedPlanId: record.linkedPlanId }
            : {}),
          ...(typeof record.linkedCalendarItemId === 'string'
            ? { linkedCalendarItemId: record.linkedCalendarItemId }
            : {}),
          ...(typeof record.linkedRecordId === 'string'
            ? { linkedRecordId: record.linkedRecordId }
            : {}),
        });
      },
    };

    ctx.provide('zhibanPatientH5Followup', {
      list: (query: { status?: string; patientIds?: string[] }) =>
        followups.listForTeam(query as never),
      claim: (input: { id: string; accountId: string; accountName: string }) => followups.claim(input),
      resolve: (input: { id: string; accountId: string; note: string }) => followups.resolve(input),
      unresolvedCount: (patientIds?: string[]) => followups.unresolvedCount(patientIds),
      escalateOverdue: () => followups.escalateOverdue(),
      get: (id: string) => followups.findById(id),
    });

    ctx.provide('zhibanPatientH5Plan', {
      list: (patientId: string) => plan.list(patientId),
      get: (id: string) => plan.get(id),
      generate: (input) => plan.generate(input),
      createManualDraft: (input) => plan.createManualDraft(input),
      update: (input) => plan.update(input as never),
      reject: (input) => plan.reject(input),
      publish: (input) => plan.publish(input),
      suspend: (input) => plan.suspend(input),
      resume: (input) => plan.resume(input),
      end: (input) => plan.end(input),
    } satisfies PatientH5PlanApi);

    const calendarService = new CalendarService({
      tenantId: config.tenantId,
      plan,
      backend: planBackend,
      followups: adjust,
      ids: idFactory(Date.now),
    });
    const recordBackend =
      recordTable && mediaTable
        ? new DomainRecordBackend(recordTable, mediaTable, idempotencyTable, config.tenantId)
        : new MemoryRecordBackend();
    const recordService = new RecordService({
      tenantId: config.tenantId,
      backend: recordBackend,
      recognition: UNCONFIGURED_RECOGNITION,
      ids: idFactory(Date.now),
      sideEffects: {
        createRiskFollowup: async (input) => {
          // 不适反馈按风险类处理：SLA 更短，且不会被当成普通计划调整
          await followups.create({
            patientId: input.patientId,
            kind: 'risk',
            message: input.message,
            riskLevel: 'medium',
            linkedRecordId: input.recordId,
          });
        },
        matchCalendarItem: async (input) => {
          await calendarService.matchRecord(input);
        },
      },
    });
    const mediaStore = new MemoryMediaStore();

    const prefsStore = new MemoryReminderPrefsStore();
    const reminderBackend = reminderTable
      ? {
          load: () =>
            [...reminderTable!.entries()]
              .map(([, value]) => value as never)
              .filter((item) => (item as { tenantId?: string }).tenantId === config.tenantId),
          put: (record: { id: string }) => reminderTable!.put(record.id, record),
        }
      : new MemoryReminderBackend();
    const reminders = new ReminderService({
      tenantId: config.tenantId,
      backend: reminderBackend as never,
      ids: idFactory(Date.now),
      loadItems: (patientId) => plan.listCalendarItems(patientId),
      loadPlanStatus: (patientId) => plan.currentForPatient(patientId)?.status,
      prefsOf: (patientId) => prefsStore.load(patientId),
      onAudit: (event) => ctx.emit('h5.reminder.audit', event),
    });

    ctx.provide('zhibanPatientH5Reminder', {
      list: (query: { patientId?: string; status?: string; date?: string }) =>
        reminders.list(query as never),
      usage: (patientId: string, date?: string) => reminders.usage(patientId, date),
      generateForPatient: (patientId: string) => reminders.generateForPatient(patientId),
      gentleInquiry: (patientId: string) => reminders.gentleInquiry(patientId),
      enqueue: (id: string) => reminders.enqueue(id),
      cancel: (id: string, reason?: never) => reminders.cancel(id, reason ?? 'team_cancelled'),
      cancelForPlan: (patientId: string, reason: never, itemIds?: string[]) =>
        reminders.cancelForPlan(patientId, { reason, ...(itemIds ? { itemIds } : {}) }),
      markSent: (id: string, draftId?: string) =>
        reminders.markSent({ id, ...(draftId ? { draftId } : {}) }),
      markVerified: (id: string, verificationId?: string) =>
        reminders.markVerified(id, verificationId),
      markFailed: (id: string, errorCode: string) => reminders.markFailed(id, errorCode),
    });

    const center = new ProfileCenterService({
      profile,
      records: recordService,
      followups,
      prefsStore,
      // 陪伴天数以服务开始时间为准；没有服务开始时间时退回绑定时间
      startedAtOf: (patientId) =>
        patientView(patientId)?.accompaniedSince ?? service.getBinding(patientId)?.boundAt ?? null,
    });

    const contentBackend = contentTable
      ? {
          load: () =>
            [...contentTable!.entries()]
              .map(([, value]) => value as never)
              .filter((item) => (item as { tenantId?: string }).tenantId === config.tenantId),
          put: (record: { id: string }) => contentTable!.put(record.id, record),
        }
      : new MemoryContentBackend();
    const content = new ContentService({
      tenantId: config.tenantId,
      backend: contentBackend as never,
      ids: idFactory(Date.now),
      onAudit: (event) => ctx.emit('h5.content.audit', event),
    });
    ctx.provide('zhibanPatientH5Content', content);

    const extensions = [
      ...createContentRoutes({ content }),
      ...createProfileCenterRoutes({
        center,
        tenantReminderDefaults: { dailyLimit: 2, quietHours: { start: '21:00', end: '08:00' } },
      }),
      ...createFollowupRoutes({
        followups,
        team: () => ({
          advisorName: patientView('')?.advisorId ? '负责顾问' : '负责顾问',
          members: [],
          serviceHours: config.serviceHours ?? '工作日 09:00–18:00',
          categories: [
            { key: 'plan', label: '计划问题' },
            { key: 'record', label: '记录问题' },
            { key: 'body', label: '身体感受' },
            { key: 'other', label: '其他' },
          ],
        }),
      }),
      ...createRecordRoutes({ records: recordService, media: mediaStore }),
      ...createCalendarRoutes({
        calendar: calendarService,
        companionDays: (patientId) => {
          const days = center.stats(patientId).companionDays;
          return days > 0 ? days : null;
        },
      }),
      ...createPlanRoutes({ plan, adjust, ids: idFactory(Date.now) }),
      ...createProfileRoutes({ profile, manifesto: config.manifesto }),
    ];
    registerPatientH5Http(ctx.webServer, {
      service,
      allowedOrigins: config.allowedOrigins,
      cookieSecure: config.cookieSecure,
      log,
      extensions,
      composeMe: (view) => {
        const patientId = view.session.patientId;
        const current = plan.currentForPatient(patientId);
        const latest = plan.list(patientId)[0];
        const status =
          current?.status === 'published'
            ? 'plan_active'
            : current?.status === 'suspended'
              ? 'plan_suspended'
              : latest?.status === 'data_pending'
                ? 'data_pending'
                : latest && ['reviewing', 'generating', 'generate_failed'].includes(latest.status)
                  ? 'plan_generating'
                  : profile.meStatus(patientId, view.patient.status);
        // 陪伴天数以服务开始时间为准；stats 在没有开始时间时给 0，这里转成 null 让前端显示占位
        const companionDays = center.stats(patientId).companionDays;
        return {
          status,
          profile: profile.status(patientId),
          companionDays: companionDays > 0 ? companionDays : null,
        };
      },
    });

    log('患者端 H5 接口已注册：/zhiban/h5');
  });
}
