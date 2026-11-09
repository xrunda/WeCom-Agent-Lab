/**
 * zhiban-care DSH 插件入口（#36）。
 *
 * 装配：打开 zhiban_care 领域 → CareService（安静时段 / 到期 / 重启恢复）→
 * 注册 schedule_create → 提供 `zhibanCare` 给控制台与 zhiban-patient。
 *
 * 到期投递：调用 zhiban-patient 的 startProactiveTurn；患者域未就绪时
 * 顺延 60 秒再看，不丢计划。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import { CareService } from '../../src/p1/care.ts';
import type { CarePlanCreateInput, CarePlanRecord, CarePlanStatus } from '../../src/p1/care.ts';
import { buildCareToolDefinitions } from '../../src/p1/care-tools.ts';
import type { AuditEvent } from '../../src/c2/types.ts';

import { parseCareConfig } from './config.ts';
import { DomainCareBackend, careAuditTable, careDomain } from './domain.ts';

export const name = 'zhiban-care';

export const inject = ['storageDomain'];

type EffectCleanup = void | (() => void | Promise<void>);

interface ProactiveResult {
  status: 'draft' | 'skipped' | 'deferred' | 'failed';
  retryAt?: number;
  reason?: string;
}

interface PatientRuntimeLike {
  patientContextForSession(sessionId: string): { patientId: string } | undefined;
  startProactiveTurn(input: {
    patientId: string;
    planId: string;
    title: string;
  }): Promise<ProactiveResult>;
}

export interface DshCareContext {
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

export interface CareRuntimeApi {
  available(): boolean;
  list(patientId?: string, status?: CarePlanStatus): CarePlanRecord[];
  create(input: CarePlanCreateInput): CarePlanRecord;
  cancel(id: string): CarePlanRecord;
}

export function apply(ctx: DshCareContext, rawConfig: unknown): void {
  const config = parseCareConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-care] ${line}`);
  log(
    `加载配置：租户=${config.tenantId} 时区=${config.timeZone} ` +
      `安静时段=${config.quietHours.start}:00–${config.quietHours.end}:00`,
  );

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(careDomain);
    let service: CareService | undefined;

    try {
      const auditTable = careAuditTable(domain);
      let auditSeq = 0;
      service = new CareService({
        tenantId: config.tenantId,
        backend: new DomainCareBackend(domain),
        timeZone: config.timeZone,
        quietHours: config.quietHours,
        sandbox: config.sandbox,
        emit: (type, data) => {
          ctx.emit(type, data);
        },
        onAudit: (event: AuditEvent) => {
          auditSeq += 1;
          void auditTable
            .put(`${event.at}_${auditSeq}`, event)
            .catch((error: unknown) => {
              log(`审计写入失败：${error instanceof Error ? error.message : String(error)}`);
            });
        },
        onPersistError: (error) => {
          log(`领域存储写入失败：${error.message}`);
          ctx.emit('alert.created', {
            kind: 'PERSIST_FAILED',
            message: `主动计划领域存储写入失败：${error.message}`,
            at: Date.now(),
          });
        },
      });

      const patientRuntime = (): PatientRuntimeLike | undefined =>
        ctx.get<PatientRuntimeLike>('zhibanPatient');

      for (const tool of buildCareToolDefinitions({
        patientForSession: (sessionId) =>
          patientRuntime()?.patientContextForSession(sessionId)?.patientId,
        create: (input) => service!.create(input),
      })) {
        ctx.tools.register(tool);
      }

      service.start(async (plan) => {
        const runtime = patientRuntime();
        if (!runtime) {
          service!.defer(plan.id, Date.now() + 60_000, 'PATIENT_UNAVAILABLE');
          return;
        }
        const result = await runtime.startProactiveTurn({
          patientId: plan.patientId,
          planId: plan.id,
          title: plan.title,
        });
        if (result.status === 'deferred') {
          service!.defer(plan.id, result.retryAt ?? Date.now() + 60_000, result.reason ?? 'DEFERRED');
          return;
        }
        if (result.status === 'failed') {
          service!.markDone(plan.id);
          log(`主动计划未能产出草稿 plan=${plan.id} reason=${result.reason ?? 'UNKNOWN'}`);
          ctx.emit('care_plan.failed', {
            planId: plan.id,
            patientId: plan.patientId,
            reason: result.reason ?? 'UNKNOWN',
          });
          return;
        }
        service!.markDone(plan.id);
      });

      const api: CareRuntimeApi = {
        available: () => true,
        list: (patientId, status) => service!.list(patientId, status),
        create: (input) => service!.create(input),
        cancel: (id) => service!.cancel(id),
      };
      ctx.provide('zhibanCare', api);

      const pending = service.list(undefined, 'pending');
      log(`已就绪：待执行计划 ${pending.length} 条，schedule_create 已注册`);

      return async () => {
        service?.dispose();
        await service?.flush();
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      service?.dispose();
      await service?.flush();
      await domain.close();
      throw error;
    }
  });
}
