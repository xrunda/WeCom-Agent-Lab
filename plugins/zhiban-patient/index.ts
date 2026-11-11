/**
 * zhiban-patient DSH 插件入口（#33 / #34 / #56 / #63）。
 *
 * 装配顺序：
 *   打开患者领域 → 患者服务（同步路由）→ DSH 长期会话适配 →
 *   注册 reply_draft / reply_skip → 提供 `zhibanPatient` 服务。
 *
 * 与 zhiban-wecom 解耦：草稿操作通过 `ctx.get('zhibanWecom')` 懒加载，
 * 两个插件谁先加载都能启动；wecom 未就绪时读操作安全降级，写操作报错。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { buildMealToolDefinitions } from '../../src/p1/meal-tools.ts';
import { MemoryPatientStore } from '../../src/p1/patient-store.ts';
import { PatientService } from '../../src/p1/patient-service.ts';
import { buildReplyToolDefinitions } from '../../src/p1/reply-tools.ts';
import { PatientAgentRuntime } from '../../src/p1/runtime.ts';
import { MEAL_VISION_SKILL } from '../../src/p1/vision.ts';
import type { MealLogRecord } from '../../src/p1/vision.ts';
import type {
  DraftGuardPort,
  SandboxDraftSink,
  SandboxPatientLike,
  SandboxTurnInput,
} from '../../src/p1/runtime.ts';
import type { DraftReviewInput, DraftReviewResult } from '../../src/p1/guard.ts';
import type { PatientBridge, RuntimeStats } from '../../src/p1/session-port.ts';
import type { ProactiveTurnInput, ProactiveTurnResult } from '../../src/p1/runtime.ts';
import type {
  AdvisorRecord,
  AgentCapabilities,
  ConsentStatus,
  GroupBinding,
  GroupMember,
  GroupServiceStatus,
  InboundMessage,
  ManagedGroup,
  Patient,
  PatientMemoryPort,
  PatientSessionRecord,
  RouteDecision,
} from '../../src/p1/types.ts';
import type { Draft, VerifyOutcome } from '../../src/c2/types.ts';

import { parsePatientConfig } from './config.ts';
import type { PatientPluginConfig } from './config.ts';
import { DomainPatientBackend, patientDomain } from './domain.ts';
import { DshPatientSessions } from './sessions.ts';
import type { SessionControllerLike } from './sessions.ts';

export const name = 'zhiban-patient';

/** storageDomain 由 dsh-storage-domain 提供；sessionController / tools 由宿主提供 */
export const inject = ['storageDomain', 'sessionController', 'tools'];

type EffectCleanup = void | (() => void | Promise<void>);

export interface DshPatientContext {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => EffectCleanup | Promise<EffectCleanup>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  get<T = unknown>(name: string): T | undefined;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
  sessionController: SessionControllerLike;
  tools: {
    register(definition: unknown): unknown;
  };
}

/** 控制台群列表视图：不暴露 tenantId / deletedAt 等内部字段 */
export interface PatientGroupView {
  id: string;
  roomId: string;
  name: string;
  nameSource: string;
  status: GroupServiceStatus;
  advisorId?: string;
  patientIds: string[];
  memberCount: number;
  externalMemberCount: number;
  consent: { agreed: number; unknown: number; disagreed: number };
  lastActiveAt?: number;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PatientGroupPatch {
  name?: string;
  status?: GroupServiceStatus;
  advisorId?: string;
}

/** 提供给 zhiban-wecom 调用的小接口 */
export interface PatientRuntimeApi {
  observeRooms(
    rooms: Array<{
      roomId: string;
      members: Array<{
        id: string;
        isExternal: boolean;
        lastActiveAt: number;
        /** 客户联系 API 拿到的群昵称；缺省时患者域回退 id 尾号 */
        displayName?: string;
      }>;
      /** 整群昵称映射；用于更新本轮未发言的成员并回填患者 */
      memberNames?: Record<string, string>;
      /** 会话存档同意状态；由企微 check_room_agree 返回，缺省时保持原状态 */
      memberConsent?: Record<string, ConsentStatus>;
    }>,
  ): void;
  routeInbound(message: InboundMessage): { handled: boolean; decision: RouteDecision };
  flushDue(): Promise<void>;
  handleDraftVerified(draftId: string, outcome: VerifyOutcome): Promise<void>;
  handleAdvisorText(advisorUserId: string, text: string): Promise<boolean>;
  /** #36：zhiban-care 到期后调用 */
  startProactiveTurn(input: ProactiveTurnInput): Promise<ProactiveTurnResult>;
  /** #35：zhiban-memory 工具用会话 id 找患者 */
  patientContextForSession(
    sessionId: string,
  ): { patientId: string; sourceMsgId?: string; defaultSubject: 'self' | 'family' | 'unknown' } | undefined;
  stats(): RuntimeStats;
  /** #37：给 zhiban-guard 的 escalate_to_human 反查患者 */
  patientForSession(sessionId: string): string | undefined;
  systemPrompt(): string;
  /** #41：租户人设修改后立即应用到下一轮 */
  applySettings(patch: { agentName?: string; patientTerm?: string; tone?: string }): void;
  /** #40：体验中心沙盒（真 Agent / 真工具，草稿回控制台） */
  sandboxEnsure(patient: SandboxPatientLike): Promise<string>;
  sandboxReset(patient: SandboxPatientLike): Promise<string>;
  sandboxTurn(input: SandboxTurnInput): Promise<void>;
  sandboxInjectContext(sessionId: string, text: string): Promise<void>;
  getPatient(id: string): { id: string; displayName: string } | undefined;
  /** #59：按患者导出服务记录时，取患者与其绑定的服务群 */
  getPatientGroups(id: string):
    | {
        patient: { id: string; displayName: string };
        groups: Array<{
          id: string;
          name: string;
          roomId: string;
          status?: GroupServiceStatus;
          isPrimary?: boolean;
        }>;
      }
    | undefined;
  /** 控制台患者列表 / 详情（真实存量数据，不含沙盒） */
  listPatients(): Patient[];
  getPatientAdmin(id: string): Patient | undefined;
  /** 控制台顾问列表 / 状态操作 */
  listAdvisors(): AdvisorRecord[];
  getAdvisor(id: string): AdvisorRecord | undefined;
  updatePatient(
    id: string,
    patch: Partial<
      Pick<
        Patient,
        'displayName' | 'avatar' | 'tags' | 'advisorId' | 'consent' | 'status' | 'externalUserId'
      >
    >,
  ): Patient;
  updateAdvisor(
    id: string,
    patch: Partial<Pick<AdvisorRecord, 'name' | 'status' | 'seatExpireAt' | 'chatBound'>>,
  ): AdvisorRecord;
  /** 控制台群管理：新建患者（绑定新患者时使用） */
  createPatient(input: {
    displayName: string;
    externalUserId?: string;
    tags?: string[];
    advisorId?: string;
    consent?: ConsentStatus;
  }): Patient;
  /** 控制台群管理：把患者绑定到服务群 */
  bindPatient(groupId: string, patientId: string, isPrimary?: boolean): GroupBinding;
  /** 患者 ↔ 群绑定（含是否主群） */
  getPatientBindings(id: string): Array<{ groupId: string; isPrimary: boolean }>;
  /** 确认 / 改绑患者身份：把患者指向服务群里的一位外部成员 */
  setPatientIdentity(
    groupId: string,
    patientId: string,
    externalUserId: string,
    opts?: { displayName?: string },
  ): Patient;
  /** 服务群成员列表（含角色/同意），用于「设为患者」选择 */
  listGroupMembers(groupId: string): GroupMember[];
  /** #59：数据与安全页的患者存档同意状态统计 */
  consentStats(): { agreed: number; unknown: number; disagreed: number; total: number };
  /** #55：饮食记录，控制台 Agent 主页读取 */
  listMealLogs(patientId: string): MealLogRecord[];
  /** 控制台群管理：列表与服务状态入口 */
  listGroups(): PatientGroupView[];
  updateGroup(groupId: string, patch: PatientGroupPatch): PatientGroupView;
}

/** #35：zhiban-memory 未安装时安全降级为空 */
export class LazyMemoryPort implements PatientMemoryPort {
  private readonly resolve: () => PatientMemoryPort | undefined;

  constructor(resolve: () => PatientMemoryPort | undefined) {
    this.resolve = resolve;
  }

  available(): boolean {
    return this.resolve() !== undefined;
  }

  render(patientId: string): string[] {
    return this.resolve()?.render(patientId) ?? [];
  }
}

/**
 * 懒加载 zhiban-wecom 的 PatientBridge。
 * 读操作在 wecom 未就绪时返回空值，避免上下文线程被打断；
 * 写操作明确报错，由 runtime 降级并记录。
 */
export class LazyPatientBridge implements PatientBridge {
  private readonly resolve: () => PatientBridge | undefined;

  constructor(resolve: () => PatientBridge | undefined) {
    this.resolve = resolve;
  }

  private require(): PatientBridge {
    const bridge = this.resolve();
    if (!bridge) throw new Error('WECOM_BRIDGE_UNAVAILABLE');
    return bridge;
  }

  async enqueueDraft(input: Parameters<PatientBridge['enqueueDraft']>[0]) {
    return this.require().enqueueDraft(input);
  }

  async reviseDraft(draftId: string, input: Parameters<PatientBridge['reviseDraft']>[1]) {
    return this.require().reviseDraft(draftId, input);
  }

  requestRevision(draftId: string, instruction: string): void {
    this.require().requestRevision(draftId, instruction);
  }

  getActiveDraft(advisorId: string): Draft | undefined {
    return this.resolve()?.getActiveDraft(advisorId);
  }

  getDraft(draftId: string): Draft | undefined {
    return this.resolve()?.getDraft(draftId);
  }

  listVerifiedBodies(senderId: string): string[] {
    return this.resolve()?.listVerifiedBodies(senderId) ?? [];
  }

  async notifyAdvisor(text: string): Promise<void> {
    return this.require().notifyAdvisor(text);
  }
}

/**
 * 懒加载 zhiban-guard 的草稿门禁（#37）。
 * guard 未安装时返回「未命中」，草稿按原样入队，不阻塞患者流程。
 */
export class LazyDraftGuard implements DraftGuardPort {
  private readonly resolve: () => DraftGuardPort | undefined;

  constructor(resolve: () => DraftGuardPort | undefined) {
    this.resolve = resolve;
  }

  review(input: DraftReviewInput): DraftReviewResult {
    const guard = this.resolve();
    if (guard) return guard.review(input);
    return {
      riskLevel: input.riskLevel,
      hits: [],
      hitNames: [],
      actions: [],
      escalate: false,
      guideOnly: false,
    };
  }

  linkDraft(alertId: string, draftId: string): void {
    this.resolve()?.linkDraft?.(alertId, draftId);
  }
}

export function apply(ctx: DshPatientContext, rawConfig: unknown): void {
  const config = parsePatientConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-patient] ${line}`);

  log(
    `加载配置：租户=${config.tenantId} 顾问=${config.settings.advisorId} ` +
      `合并窗口=${config.mergeWindowMs}ms`,
  );

  ctx.effect(async () => {
    // #55：meal-vision skill 是纯文本，不含租户信息与密钥；同名文件幂等覆盖
    if (config.skillDir) {
      try {
        await mkdir(config.skillDir, { recursive: true });
        await writeFile(join(config.skillDir, 'meal-vision.md'), MEAL_VISION_SKILL, 'utf8');
        log(`meal-vision skill 已写入 ${config.skillDir}`);
      } catch (error) {
        log(`meal-vision skill 写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const domain = await ctx.storageDomain.open(patientDomain);
    let runtime: PatientAgentRuntime | undefined;
    let store: MemoryPatientStore | undefined;

    try {
      store = new MemoryPatientStore({
        backend: new DomainPatientBackend(domain),
        onPersistError: (error) => {
          log(`领域存储写入失败：${error.message}`);
          ctx.emit('alert.created', {
            kind: 'PERSIST_FAILED',
            message: `患者领域存储写入失败：${error.message}`,
            at: Date.now(),
          });
        },
      });

      const clock = { now: () => Date.now() };
      const service = new PatientService(store, clock, {
        tenantId: config.tenantId,
        requireConsentForTurn: config.requireConsentForTurn,
        demo: config.demo,
      });
      service.upsertAdvisor({
        id: config.settings.advisorId,
        wecomUserId: config.advisorWecomUserId,
        name: config.settings.advisorName,
        chatBound: true,
      });

      const sessions = new DshPatientSessions(ctx, {
        workspaceRoot: config.workspaceRoot,
        agentPreset: config.agentPreset,
        findSession: (patientId) => store?.getSession(patientId),
        saveSession: (record: PatientSessionRecord) => store?.saveSession(record),
        logger: log,
      });

      const bridge = new LazyPatientBridge(
        () => ctx.get<PatientBridge>('zhibanWecom'),
      );
      // #37：zhiban-guard 未安装时不做红线校验（直通）
      const guard = new LazyDraftGuard(
        () => ctx.get<DraftGuardPort>('zhibanGuard'),
      );
      // #35：zhiban-memory 未安装时返回空，提示词里也不出现记忆工具约定
      const memory = new LazyMemoryPort(() =>
        ctx.get<PatientMemoryPort>('zhibanMemory'),
      );
      const capabilities = (): AgentCapabilities => ({
        memory: ctx.get('zhibanMemory') !== undefined,
        care: ctx.get('zhibanCare') !== undefined,
      });

      runtime = new PatientAgentRuntime({
        service,
        settings: config.settings,
        bridge,
        guard,
        sessions,
        emit: (type, data) => {
          ctx.emit(type, data);
        },
        logger: log,
        mergeWindowMs: config.mergeWindowMs,
        mergeMaxWaitMs: config.mergeMaxWaitMs,
        turnTimeoutMs: config.turnTimeoutMs,
        memory,
        capabilities,
        maxProactivePerHour: config.maxProactivePerHour,
        sandboxSink: () => ctx.get<SandboxDraftSink>('zhibanSandboxSink'),
      });

      for (const tool of buildReplyToolDefinitions({
        replyDraft: (sessionId, input) => runtime!.replyDraft(sessionId, input),
        replySkip: (sessionId, input) => runtime!.replySkip(sessionId, input),
      })) {
        ctx.tools.register(tool);
      }
      // #55：图片类型判断与饮食记录
      for (const tool of buildMealToolDefinitions({
        imageClassify: (sessionId, input) => runtime!.imageClassify(sessionId, input),
        mealLogWrite: (sessionId, input) => runtime!.mealLogWrite(sessionId, input),
      })) {
        ctx.tools.register(tool);
      }

      const groupView = (group: ManagedGroup): PatientGroupView => {
        const members = store?.listMembers(group.id) ?? [];
        const consent = { agreed: 0, unknown: 0, disagreed: 0 };
        for (const member of members) {
          if (member.isExternal) consent[member.consent] += 1;
        }
        return {
          id: group.id,
          roomId: group.roomId,
          name: group.name,
          nameSource: group.nameSource,
          status: group.status,
          ...(group.advisorId ? { advisorId: group.advisorId } : {}),
          patientIds: (store?.listBindingsByGroup(group.id) ?? []).map(
            (binding) => binding.patientId,
          ),
          memberCount: group.memberCount,
          externalMemberCount: group.externalMemberCount,
          consent,
          ...(group.lastActiveAt !== undefined ? { lastActiveAt: group.lastActiveAt } : {}),
          demo: group.demo,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        };
      };

      const asSandboxPatient = (input: SandboxPatientLike): Patient => {
        const at = Date.now();
        return {
          id: input.id,
          tenantId: input.tenantId,
          displayName: input.displayName,
          externalUserId: input.externalUserId,
          tags: [],
          consent: 'unknown',
          status: 'serving',
          demo: false,
          accompaniedSince: at,
          createdAt: at,
          updatedAt: at,
        };
      };

      const api: PatientRuntimeApi = {
        observeRooms: (rooms) => runtime!.observeRooms(rooms),
        routeInbound: (message) => runtime!.routeInbound(message),
        flushDue: () => runtime!.flushDue(),
        handleDraftVerified: (draftId, outcome) =>
          runtime!.handleDraftVerified(draftId, outcome),
        handleAdvisorText: (advisorUserId, text) =>
          runtime!.handleAdvisorText(advisorUserId, text),
        startProactiveTurn: (input) => runtime!.startProactiveTurn(input),
        patientContextForSession: (sessionId) =>
          runtime!.patientContextForSession(sessionId),
        stats: () => runtime!.stats(),
        patientForSession: (sessionId) => runtime!.patientForSession(sessionId),
        systemPrompt: () => runtime!.systemPrompt(),
        applySettings: (patch) => {
          runtime!.applySettings(patch);
          const parts: string[] = [];
          if (patch.agentName) parts.push(`助手名「${patch.agentName}」`);
          if (patch.patientTerm) parts.push(`统一称呼「${patch.patientTerm}」`);
          if (patch.tone) parts.push(`语气：${patch.tone}`);
          if (parts.length === 0) return;
          const note = `[租户设置更新] ${parts.join('；')}。后续回复按新设置。`;
          // 系统提示词只在会话创建时注入一次；给已有会话补一条上下文，不唤醒回合
          for (const record of store?.listSessions() ?? []) {
            void sessions
              .injectContext(record.sessionId, note)
              .catch((error: unknown) => {
                log(`设置更新注入失败：${error instanceof Error ? error.message : String(error)}`);
              });
          }
        },
        sandboxEnsure: async (patient) => (await sessions.ensure(asSandboxPatient(patient))).sessionId,
        sandboxReset: async (patient) => (await sessions.reset(asSandboxPatient(patient))).sessionId,
        sandboxTurn: (input) => runtime!.runSandboxTurn(input),
        sandboxInjectContext: (sessionId, text) => sessions.injectContext(sessionId, text),
        getPatient: (id) => {
          const patient = store?.getPatient(id);
          return patient ? { id: patient.id, displayName: patient.displayName } : undefined;
        },
        getPatientGroups: (id) => {
          const patient = store?.getPatient(id);
          if (!patient || patient.deletedAt !== undefined) return undefined;
          const bindings = store?.listBindingsByPatient(id) ?? [];
          const groups = service
            .groupIdsFor(id)
            .map((groupId) => store?.getGroup(groupId))
            .filter(
              (group): group is ManagedGroup =>
                group !== undefined && group.deletedAt === undefined,
            )
            .map((group) => ({
              id: group.id,
              name: group.name,
              roomId: group.roomId,
              status: group.status,
              isPrimary: bindings.find((item) => item.groupId === group.id)?.isPrimary ?? false,
            }));
          return { patient: { id: patient.id, displayName: patient.displayName }, groups };
        },
        listPatients: () =>
          (store?.listPatients() ?? [])
            .filter((patient) => patient.deletedAt === undefined)
            .map((patient) => ({ ...patient, tags: [...patient.tags] })),
        getPatientAdmin: (id) => {
          const patient = store?.getPatient(id);
          if (!patient || patient.deletedAt !== undefined) return undefined;
          return { ...patient, tags: [...patient.tags] };
        },
        listAdvisors: () => (store?.listAdvisors() ?? []).map((advisor) => ({ ...advisor })),
        getAdvisor: (id) => {
          const advisor = store?.getAdvisor(id);
          return advisor ? { ...advisor } : undefined;
        },
        updatePatient: (id, patch) => {
          const updated = service.updatePatient(id, patch);
          return { ...updated, tags: [...updated.tags] };
        },
        updateAdvisor: (id, patch) => ({ ...service.updateAdvisor(id, patch) }),
        createPatient: (input) => {
          const created = service.createPatient(input);
          return { ...created, tags: [...created.tags] };
        },
        bindPatient: (groupId, patientId, isPrimary) => ({
          ...service.bindPatient(groupId, patientId, isPrimary),
        }),
        getPatientBindings: (id) =>
          (store?.listBindingsByPatient(id) ?? []).map((binding) => ({
            groupId: binding.groupId,
            isPrimary: binding.isPrimary,
          })),
        setPatientIdentity: (groupId, patientId, externalUserId, opts = {}) => {
          const updated = service.setPatientIdentity(groupId, patientId, externalUserId, opts);
          return { ...updated, tags: [...updated.tags] };
        },
        listGroupMembers: (groupId) =>
          (store?.listMembers(groupId) ?? []).map((member) => ({ ...member })),
        consentStats: () => {
          const stats = { agreed: 0, unknown: 0, disagreed: 0, total: 0 };
          for (const patient of store?.listPatients() ?? []) {
            if (patient.deletedAt !== undefined) continue;
            stats.total += 1;
            stats[patient.consent] += 1;
          }
          return stats;
        },
        listMealLogs: (patientId) => store?.listMealLogs(patientId) ?? [],
        listGroups: () => service.listGroups().map(groupView),
        updateGroup: (groupId, patch) => groupView(service.updateGroup(groupId, patch)),
      };
      ctx.provide('zhibanPatient', api);

      log('已就绪：reply_draft / reply_skip / image_classify / meal_log_write 已注册');

      return async () => {
        runtime?.dispose();
        await store?.flush();
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      await store?.flush();
      await domain.close();
      throw error;
    }
  });
}

/** 供控制台/测试读取患者视图的辅助类型 */
export type PatientView = Pick<
  Patient,
  'id' | 'displayName' | 'externalUserId' | 'consent' | 'status' | 'advisorId'
>;
