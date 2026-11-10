/**
 * zhiban-memory DSH 插件入口（#35）。
 *
 * 装配：打开 zhiban_memory 领域 → MemoryService（同步读、串行落盘）→
 * 注册 memory_write / memory_update / memory_list → 提供 `zhibanMemory`
 * 给 zhiban-patient 每轮注入、给控制台查询。
 *
 * 与 zhiban-patient 解耦：工具通过 `ctx.get('zhibanPatient')` 懒加载
 * 会话→患者映射；患者域未就绪时工具明确报错，不写错患者。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { MemoryError, MemoryService } from '../../src/p1/memory.ts';
import type {
  MemoryQuery,
  MemoryRecord,
  MemoryUpdateInput,
  MemoryWriteInput,
} from '../../src/p1/memory.ts';
import { buildMemoryToolDefinitions } from '../../src/p1/memory-tools.ts';
import type { AuditEvent } from '../../src/c2/types.ts';

import { parseMemoryConfig } from './config.ts';
import { DomainMemoryBackend, memoryAuditTable, memoryDomain } from './domain.ts';

export const name = 'zhiban-memory';

/** storageDomain 由 dsh-storage-domain 提供 */
export const inject = ['storageDomain', 'tools'];

type EffectCleanup = void | (() => void | Promise<void>);

interface PatientSessionContext {
  patientId: string;
  sourceMsgId?: string;
  defaultSubject: 'self' | 'family' | 'unknown';
}

interface PatientRuntimeLike {
  patientContextForSession(sessionId: string): PatientSessionContext | undefined;
}

export interface DshMemoryContext {
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

/** 提供给 zhiban-patient / 控制台的记忆接口 */
export interface MemoryRuntimeApi {
  available(): boolean;
  render(patientId: string): string[];
  list(patientId: string, query?: MemoryQuery): MemoryRecord[];
  get(id: string): MemoryRecord | undefined;
  count(patientId: string): number;
  /** 控制台：顾问/主管手动写入、修订、软删除（写审计由 MemoryService 负责） */
  write(input: MemoryWriteInput): MemoryRecord;
  update(
    id: string,
    patch: MemoryUpdateInput,
    actor?: 'agent' | 'staff',
    actorId?: string,
  ): MemoryRecord;
  remove(id: string, actor?: 'agent' | 'staff', actorId?: string): MemoryRecord;
}

export function apply(ctx: DshMemoryContext, rawConfig: unknown): void {
  const config = parseMemoryConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-memory] ${line}`);
  log(`加载配置：租户=${config.tenantId} 注入上限=${config.injectLimit}`);

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(memoryDomain);
    let service: MemoryService | undefined;

    try {
      const auditTable = memoryAuditTable(domain);
      let auditSeq = 0;
      service = new MemoryService({
        tenantId: config.tenantId,
        backend: new DomainMemoryBackend(domain),
        injectLimit: config.injectLimit,
        sandbox: config.sandbox,
        emit: (type, data) => {
          ctx.emit(type, data);
        },
        onPersistError: (error) => {
          log(`领域存储写入失败：${error.message}`);
          ctx.emit('alert.created', {
            kind: 'PERSIST_FAILED',
            message: `记忆领域存储写入失败：${error.message}`,
            at: Date.now(),
          });
        },
        onAudit: (event: AuditEvent) => {
          auditSeq += 1;
          void auditTable
            .put(`${event.at}_${auditSeq}`, event)
            .catch((error: unknown) => {
              log(`审计写入失败：${error instanceof Error ? error.message : String(error)}`);
            });
        },
      });

      const patientRuntime = (): PatientRuntimeLike | undefined =>
        ctx.get<PatientRuntimeLike>('zhibanPatient');

      const requireContext = (sessionId: string): PatientSessionContext => {
        const context = patientRuntime()?.patientContextForSession(sessionId);
        if (!context) throw new Error('NO_PATIENT_CONTEXT');
        return context;
      };

      for (const tool of buildMemoryToolDefinitions({
        contextForSession: (sessionId) =>
          patientRuntime()?.patientContextForSession(sessionId),
        write: (sessionId, input) => {
          const context = requireContext(sessionId);
          return service!.upsertFact({
            patientId: context.patientId,
            category: input.category,
            content: input.content,
            subject: input.subject,
            sourceMsgId: input.sourceMsgId,
            sourceText: input.sourceText,
            createdBy: 'agent',
          });
        },
        update: (sessionId, input) => {
          const context = requireContext(sessionId);
          const existing = service!.get(input.id);
          if (!existing || existing.patientId !== context.patientId) {
            throw new MemoryError('WRONG_PATIENT', '这条记忆不属于当前患者');
          }
          return service!.update(input.id, input, 'agent');
        },
        list: (sessionId, input) => {
          const context = requireContext(sessionId);
          return service!.list(context.patientId, { category: input.category });
        },
      })) {
        ctx.tools.register(tool);
      }

      const api: MemoryRuntimeApi = {
        available: () => true,
        render: (patientId) => service!.render(patientId),
        list: (patientId, query) => service!.list(patientId, query),
        get: (id) => service!.get(id),
        count: (patientId) => service!.count(patientId),
        write: (input) => service!.write(input),
        update: (id, patch, actor, actorId) => service!.update(id, patch, actor, actorId),
        remove: (id, actor, actorId) => service!.remove(id, actor, actorId),
      };
      ctx.provide('zhibanMemory', api);

      log('已就绪：memory_write / memory_update / memory_list 已注册');

      return async () => {
        await service?.flush();
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      await service?.flush();
      await domain.close();
      throw error;
    }
  });
}
