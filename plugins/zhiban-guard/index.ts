/**
 * zhiban-guard DSH 插件入口（#37）。
 *
 * 装配顺序：
 *   打开红线领域 → 载入/补齐内置规则 → 注册 escalate_to_human →
 *   提供 `zhibanGuard` 服务（草稿后校验、规则 CRUD、告警查询）。
 *
 * 与 zhiban-patient 解耦：草稿校验由 patient runtime 通过 `zhibanGuard` 调用；
 * 本插件不直接接触患者数据，也不注册 reply_draft。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { buildGuardToolDefinitions } from '../../src/p1/guard-tools.ts';
import { GuardService } from '../../src/p1/guard.ts';
import type {
  DraftReviewInput,
  DraftReviewResult,
  EscalateReason,
  GuardAlertRecord,
  RiskRuleCreateInput,
  RiskRuleRecord,
  RiskRuleUpdateInput,
  RuleKind,
} from '../../src/p1/guard.ts';
import type { AuditEvent } from '../../src/c2/types.ts';

import { parseGuardConfig } from './config.ts';
import { DomainGuardBackend, guardDomain } from './domain.ts';

export const name = 'zhiban-guard';

/** storageDomain 由 dsh-storage-domain 提供；tools 由宿主提供 */
export const inject = ['storageDomain'];

type EffectCleanup = void | (() => void | Promise<void>);

export interface DshGuardContext {
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
  tools: {
    register(definition: unknown): unknown;
  };
}

/** 提供给 zhiban-patient / 控制台的接口 */
export interface GuardRuntimeApi {
  review(input: DraftReviewInput): DraftReviewResult;
  linkDraft(alertId: string, draftId: string): void;
  listRules(query?: { kind?: RuleKind; enabled?: boolean }): RiskRuleRecord[];
  getRule(id: string): RiskRuleRecord | undefined;
  createRule(input: RiskRuleCreateInput): RiskRuleRecord;
  updateRule(id: string, patch: RiskRuleUpdateInput): RiskRuleRecord;
  deleteRule(id: string): void;
  escalate(patientId: string, reason: EscalateReason, sessionId?: string): GuardAlertRecord;
  alerts(patientId?: string): GuardAlertRecord[];
  audits(): AuditEvent[];
  flush(): Promise<void>;
}

interface PatientLookup {
  patientForSession?(sessionId: string): string | undefined;
}

export function apply(ctx: DshGuardContext, rawConfig: unknown): void {
  const config = parseGuardConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-guard] ${line}`);

  log(`加载配置：租户=${config.tenantId} 沙箱=${config.sandbox}`);

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(guardDomain);
    const backend = new DomainGuardBackend(domain);

    try {
      const service = new GuardService({
        tenantId: config.tenantId,
        sandbox: config.sandbox,
        backend,
        emit: (type, data) => {
          ctx.emit(type, data);
        },
        onAudit: (event) => {
          void backend.appendAudit(event);
          ctx.emit('audit', event);
        },
        onPersistError: (error) => {
          log(`领域存储写入失败：${error.message}`);
          ctx.emit('alert.created', {
            kind: 'PERSIST_FAILED',
            message: `红线规则存储写入失败：${error.message}`,
            at: Date.now(),
          });
        },
      });

      // 首次启动补齐的内置规则先落盘，避免重启后重复写入
      await service.flush();

      for (const tool of buildGuardToolDefinitions({
        patientForSession: (sessionId) =>
          ctx.get<PatientLookup>('zhibanPatient')?.patientForSession?.(sessionId),
        escalate: (sessionId, patientId, reason) =>
          service.escalate(patientId, reason, sessionId),
      })) {
        ctx.tools.register(tool);
      }

      const api: GuardRuntimeApi = {
        review: (input) => service.review(input),
        linkDraft: (alertId, draftId) => service.linkDraft(alertId, draftId),
        listRules: (query) => service.list(query),
        getRule: (id) => service.get(id),
        createRule: (input) => service.create(input),
        updateRule: (id, patch) => service.update(id, patch),
        deleteRule: (id) => service.remove(id),
        escalate: (patientId, reason, sessionId) =>
          service.escalate(patientId, reason, sessionId),
        alerts: (patientId) => service.alerts(patientId),
        audits: () => service.audits(),
        flush: () => service.flush(),
      };
      ctx.provide('zhibanGuard', api);

      const ruleCount = service.list().length;
      log(`已就绪：${ruleCount} 条规则，escalate_to_human 已注册`);

      return async () => {
        await service.flush();
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      await domain.close();
      throw error;
    }
  });
}
