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
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { MemoryPatientStore } from '../../src/p1/patient-store.ts';
import { PatientService } from '../../src/p1/patient-service.ts';
import { buildReplyToolDefinitions } from '../../src/p1/reply-tools.ts';
import { PatientAgentRuntime } from '../../src/p1/runtime.ts';
import type { DraftGuardPort } from '../../src/p1/runtime.ts';
import type { DraftReviewInput, DraftReviewResult } from '../../src/p1/guard.ts';
import type { PatientBridge, RuntimeStats } from '../../src/p1/session-port.ts';
import type {
  InboundMessage,
  Patient,
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
export const inject = ['storageDomain', 'sessionController'];

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

/** 提供给 zhiban-wecom 调用的小接口 */
export interface PatientRuntimeApi {
  observeRooms(
    rooms: Array<{
      roomId: string;
      members: Array<{ id: string; isExternal: boolean; lastActiveAt: number }>;
    }>,
  ): void;
  routeInbound(message: InboundMessage): { handled: boolean; decision: RouteDecision };
  flushDue(): Promise<void>;
  handleDraftVerified(draftId: string, outcome: VerifyOutcome): Promise<void>;
  handleAdvisorText(advisorUserId: string, text: string): Promise<boolean>;
  stats(): RuntimeStats;
  /** #37：给 zhiban-guard 的 escalate_to_human 反查患者 */
  patientForSession(sessionId: string): string | undefined;
  systemPrompt(): string;
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
      const guard = new LazyDraftGuard(
        () => ctx.get<DraftGuardPort>('zhibanGuard'),
      );

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
      });

      for (const tool of buildReplyToolDefinitions({
        replyDraft: (sessionId, input) => runtime!.replyDraft(sessionId, input),
        replySkip: (sessionId, input) => runtime!.replySkip(sessionId, input),
      })) {
        ctx.tools.register(tool);
      }

      const api: PatientRuntimeApi = {
        observeRooms: (rooms) => runtime!.observeRooms(rooms),
        routeInbound: (message) => runtime!.routeInbound(message),
        flushDue: () => runtime!.flushDue(),
        handleDraftVerified: (draftId, outcome) =>
          runtime!.handleDraftVerified(draftId, outcome),
        handleAdvisorText: (advisorUserId, text) =>
          runtime!.handleAdvisorText(advisorUserId, text),
        stats: () => runtime!.stats(),
        patientForSession: (sessionId) => runtime!.patientForSession(sessionId),
        systemPrompt: () => runtime!.systemPrompt(),
      };
      ctx.provide('zhibanPatient', api);

      log('已就绪：reply_draft / reply_skip 已注册');

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
