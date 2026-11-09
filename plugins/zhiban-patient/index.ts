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
import type { SandboxDraftSink, SandboxPatientLike, SandboxTurnInput } from '../../src/p1/runtime.ts';
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
  systemPrompt(): string;
  /** #41：租户人设修改后立即应用到下一轮 */
  applySettings(patch: { agentName?: string; patientTerm?: string; tone?: string }): void;
  /** #40：体验中心沙盒（真 Agent / 真工具，草稿回控制台） */
  sandboxEnsure(patient: SandboxPatientLike): Promise<string>;
  sandboxReset(patient: SandboxPatientLike): Promise<string>;
  sandboxTurn(input: SandboxTurnInput): Promise<void>;
  sandboxInjectContext(sessionId: string, text: string): Promise<void>;
  getPatient(id: string): { id: string; displayName: string } | undefined;
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

      runtime = new PatientAgentRuntime({
        service,
        settings: config.settings,
        bridge,
        sessions,
        emit: (type, data) => {
          ctx.emit(type, data);
        },
        logger: log,
        mergeWindowMs: config.mergeWindowMs,
        mergeMaxWaitMs: config.mergeMaxWaitMs,
        turnTimeoutMs: config.turnTimeoutMs,
        sandboxSink: () => ctx.get<SandboxDraftSink>('zhibanSandboxSink'),
      });

      for (const tool of buildReplyToolDefinitions({
        replyDraft: (sessionId, input) => runtime!.replyDraft(sessionId, input),
        replySkip: (sessionId, input) => runtime!.replySkip(sessionId, input),
      })) {
        ctx.tools.register(tool);
      }

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
        stats: () => runtime!.stats(),
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
