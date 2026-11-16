/**
 * zhiban-advisor DSH 插件入口（#167）。
 *
 * 装配：打开会话记录域 → 会话适配器（长期会话 + session/event 回复捕获）→
 * 回合编排（并发 / 限流 / 降级）→ 注册 4 个只读工具 → 提供 `zhibanAdvisor`。
 *
 * 与 zhiban-wecom 解耦：草稿 / 承诺 / 告警 / 发消息通过 `zhibanAdvisorData`
 * 只读端口（懒加载）；知识 / 话术 / 患者 / 规则直接走 ctx.get。数据源未装时
 * 工具明确返回「还没接入」，不能把「没接入」当成「没有」。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import {
  ADVISOR_GET_SCOPES,
  ADVISOR_SEARCH_SCOPES,
  advisorIdFromSession,
  buildAdvisorToolDefinitions,
  isUsableKnowledge,
  maskedDisplayName,
  renderGet,
  searchKnowledge,
  searchScripts,
} from '../../src/p1/advisor/tools.ts';
import type {
  AdvisorChronicResult,
  AdvisorGetResult,
  AdvisorHitItem,
  AdvisorSearchResult,
  AdvisorWecomDataPort,
} from '../../src/p1/advisor/types.ts';
import { formatMeasurementValue, CHRONIC_METRICS, CHRONIC_SOURCE_LABELS } from '../../src/p1/chronic.ts';
import { riskLabel, shanghaiClock } from '../../src/c2/message.ts';
import type { ChronicProfile } from '../../src/p1/chronic.ts';
import { tailId } from '../../src/c2/redact.ts';

import { parseAdvisorConfig } from './config.ts';
import {
  AdvisorSessionStore,
  DomainAdvisorSessionBackend,
  advisorDomain,
} from './domain.ts';
import { AdvisorAgent } from './agent.ts';
import { AdvisorSessionAdapter } from './sessions.ts';
import type { SessionControllerLike } from './sessions.ts';

export const name = 'zhiban-advisor';

/** storageDomain / sessionController / tools 由宿主提供 */
export const inject = ['storageDomain', 'sessionController', 'tools'];

type EffectCleanup = void | (() => void | Promise<void>);

export interface DshAdvisorContext {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => EffectCleanup | Promise<EffectCleanup>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  get<T = unknown>(name: string): T | undefined;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
  sessionController: SessionControllerLike;
  tools: {
    register(definition: unknown): unknown;
  };
}

/** 提供给 zhiban-wecom 路由调用的小接口 */
export interface ZhibanAdvisorPort {
  enabled(): boolean;
  /** 处理一条 1:1 文本；返回是否发起了回合 */
  handle(advisorId: string, text: string): Promise<boolean>;
  /** 清空上下文 */
  reset(advisorId: string): Promise<void>;
  /** 纯编号选择：取上一条列表的第 N 条 */
  handleSelection(advisorId: string, number: number): Promise<void>;
}

/** zhiban-knowledge 的只读检索入口（与 wecom 侧同形） */
interface KnowledgeApi {
  list(query?: { q?: string; enabled?: boolean }): Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    enabled?: boolean;
    deletedAt?: number;
  }>;
}

interface ScriptsApi {
  listEnabled(): Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    tags?: string[];
  }>;
}

interface PatientLike {
  id: string;
  displayName: string;
  externalUserId?: string;
  advisorId?: string;
  tags: string[];
  consent: string;
  status: string;
  deletedAt?: number;
}

interface GroupViewLike {
  id: string;
  advisorId?: string;
}

interface PatientApi {
  listPatients(): PatientLike[];
  getPatientAdmin(id: string): PatientLike | undefined;
  getPatientBindings(id: string): Array<{ groupId: string; isPrimary: boolean }>;
  listGroups(): GroupViewLike[];
  listAdvisors(): Array<{ id: string; wecomUserId?: string }>;
  getChronicProfile(patientId: string): ChronicProfile;
}

interface GuardApi {
  getRule(id: string): {
    id: string;
    kind: string;
    name: string;
    keywords: string[];
    riskLevel: 'low' | 'medium' | 'high';
    action: string;
  } | undefined;
}

/** 懒加载 zhiban-wecom 的只读数据端口；未就绪时读操作空值、发送报错 */
class LazyAdvisorData implements AdvisorWecomDataPort {
  private readonly resolve: () => AdvisorWecomDataPort | undefined;

  constructor(resolve: () => AdvisorWecomDataPort | undefined) {
    this.resolve = resolve;
  }

  advisorName(advisorId: string): string | undefined {
    return this.resolve()?.advisorName(advisorId);
  }

  draftsFor(advisorId: string) {
    return this.resolve()?.draftsFor(advisorId) ?? [];
  }

  promisesFor(advisorId: string) {
    return this.resolve()?.promisesFor(advisorId) ?? [];
  }

  alertsFor(advisorId: string) {
    return this.resolve()?.alertsFor(advisorId) ?? [];
  }

  pendingRepliesFor?(advisorId: string): number | undefined {
    return this.resolve()?.pendingRepliesFor?.(advisorId);
  }

  activeDraftFor(advisorId: string) {
    return this.resolve()?.activeDraftFor(advisorId);
  }

  async sendText(advisorId: string, text: string): Promise<boolean> {
    const port = this.resolve();
    if (!port) return false;
    return port.sendText(advisorId, text);
  }

  get canReadPatient(): boolean {
    return this.resolve()?.canReadPatient ?? true;
  }
}

export function apply(ctx: DshAdvisorContext, rawConfig: unknown): void {
  const config = parseAdvisorConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-advisor] ${line}`);

  log(
    `加载配置：enabled=${config.enabled} workspaceRoot=${config.workspaceRoot} ` +
      `并发=${config.maxConcurrentTurns} 超时=${config.turnTimeoutMs}ms`,
  );

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(advisorDomain);
    const store = new AdvisorSessionStore(new DomainAdvisorSessionBackend(domain));
    let agent: AdvisorAgent | undefined;

    try {
      const sessions = new AdvisorSessionAdapter(ctx, {
        workspaceRoot: config.workspaceRoot,
        agentPreset: config.agentPreset,
        store,
        logger: log,
      });

      // 会话 id → 顾问 id：先查记录，再按前缀推导，双保险
      const resolveAdvisorId = (sessionId: string): string | undefined => {
        const record = store.list().find((item) => item.sessionId === sessionId);
        return record ? record.advisorId : advisorIdFromSession(sessionId);
      };

      // 数据端口懒加载：zhiban-wecom 可能晚于本插件就绪
      const data = new LazyAdvisorData(() => ctx.get<AdvisorWecomDataPort>('zhibanAdvisorData'));

      agent = new AdvisorAgent({
        sessions,
        data,
        emit: (type, payload) => ctx.emit(type, payload),
        logger: log,
        turnTimeoutMs: config.turnTimeoutMs,
        maxConcurrentTurns: config.maxConcurrentTurns,
        messagesPerMinute: config.messagesPerMinute,
        messagesPerDay: config.messagesPerDay,
      });

      const patientApi = (): PatientApi | undefined => ctx.get<PatientApi>('zhibanPatient');
      const knowledgeApi = (): KnowledgeApi | undefined => ctx.get<KnowledgeApi>('zhibanKnowledge');
      const scriptsApi = (): ScriptsApi | undefined => ctx.get<ScriptsApi>('zhibanScripts');
      const guardApi = (): GuardApi | undefined => ctx.get<GuardApi>('zhibanGuard');

      /** 顾问 id → 患者域顾问 id：wecomUserId 与 id 都可能作 key */
      const patientAdvisorId = (advisorId: string): string => {
        const advisor = patientApi()
          ?.listAdvisors()
          .find((item) => item.id === advisorId || item.wecomUserId === advisorId);
        return advisor?.id ?? advisorId;
      };

      /** 患者归属：顾问是患者的负责人，或患者绑定群里有该顾问负责的群 */
      const ownsPatient = (advisorId: string, patient: PatientLike): boolean => {
        const resolved = patientAdvisorId(advisorId);
        if (patient.advisorId === resolved) return true;
        const api = patientApi();
        if (!api) return false;
        const groups = api.listGroups();
        return api
          .getPatientBindings(patient.id)
          .some((binding) => groups.find((group) => group.id === binding.groupId)?.advisorId === resolved);
      };

      const displayNameOf = (patient: PatientLike): string => {
        const tail = patient.externalUserId ?? patient.id;
        if (!data.canReadPatient) return `患者 ${tail.slice(-6)}`;
        return maskedDisplayName(patient.displayName, tail);
      };

      const handlers = {
        overview: async (advisorId: string) => ({
          snapshot: agent!.snapshot(advisorId),
        }),
        search: async (
          advisorId: string,
          scope: (typeof ADVISOR_SEARCH_SCOPES)[number],
          query: string,
        ): Promise<AdvisorSearchResult> => {
          let items: AdvisorHitItem[] = [];
          let found = 0;
          switch (scope) {
            case 'patient': {
              const api = patientApi();
              if (!api) return { status: 'unconnected', scope };
              const matched = api
                .listPatients()
                .filter((patient) => patient.deletedAt === undefined && ownsPatient(advisorId, patient))
                .filter((patient) =>
                  (patient.displayName + ' ' + patient.tags.join(' '))
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                );
              found = matched.length;
              items = matched.slice(0, 5).map((patient) => ({
                id: patient.id,
                title: displayNameOf(patient),
                category: '患者',
                ...(patient.tags.length > 0 ? { content: `标签：${patient.tags.join('、')}` } : {}),
              }));
              break;
            }
            case 'knowledge': {
              const api = knowledgeApi();
              if (!api) return { status: 'unconnected', scope };
              const records = api.list({ enabled: true }).filter(isUsableKnowledge);
              const matched = searchKnowledge(records, query);
              found = matched.length;
              items = matched.slice(0, 5).map((record) => ({
                id: record.id,
                title: record.title,
                category: record.category,
                content: record.content,
              }));
              break;
            }
            case 'script': {
              const api = scriptsApi();
              if (!api) return { status: 'unconnected', scope };
              const matched = searchScripts(api.listEnabled(), query);
              found = matched.length;
              items = matched.slice(0, 5).map((script) => ({
                id: script.id,
                title: script.title,
                category: script.category,
                content: script.content,
                tags: script.tags,
              }));
              break;
            }
            case 'alert': {
              const alerts = data.alertsFor(advisorId);
              const matched = alerts
                .filter((alert) => (alert.title ?? '').toLowerCase().includes(query.toLowerCase()))
                .slice(0, 5);
              found = matched.length;
              items = matched.map((alert) => ({
                id: alert.id,
                title: alert.title,
                at: alert.at,
                severity: alert.severity,
                ruleIds: alert.ruleIds,
              }));
              break;
            }
          }
          agent!.recordList(advisorId, scope, items);
          return { status: 'ok', scope, query, found, items };
        },
        get: async (
          advisorId: string,
          scope: (typeof ADVISOR_GET_SCOPES)[number],
          id: string,
        ): Promise<AdvisorGetResult> => {
          switch (scope) {
            case 'patient': {
              const api = patientApi();
              if (!api) return { status: 'unconnected', scope };
              const patient = api.getPatientAdmin(id);
              if (!patient || patient.deletedAt !== undefined) {
                return { status: 'not-found', scope, id };
              }
              if (!ownsPatient(advisorId, patient)) return { status: 'forbidden' };
              return {
                status: 'ok',
                scope,
                id,
                item: {
                  id: patient.id,
                  title: displayNameOf(patient),
                  category: '患者',
                  content: [
                    `患者 id：${patient.id}`,
                    `客户 id 尾号：${(patient.externalUserId ?? patient.id).slice(-6)}`,
                    `同意状态：${patient.consent}`,
                    `服务状态：${patient.status}`,
                    ...(patient.tags.length > 0 ? [`标签：${patient.tags.join('、')}`] : []),
                  ].join('\n'),
                },
              };
            }
            case 'knowledge': {
              const api = knowledgeApi();
              if (!api) return { status: 'unconnected', scope };
              const record = api
                .list({ enabled: true })
                .filter(isUsableKnowledge)
                .find((item) => item.id === id);
              if (!record) return { status: 'not-found', scope, id };
              return {
                status: 'ok',
                scope,
                id,
                item: {
                  id: record.id,
                  title: record.title,
                  category: record.category,
                  content: record.content,
                },
              };
            }
            case 'script': {
              const api = scriptsApi();
              if (!api) return { status: 'unconnected', scope };
              const script = api.listEnabled().find((item) => item.id === id);
              if (!script) return { status: 'not-found', scope, id };
              return {
                status: 'ok',
                scope,
                id,
                item: {
                  id: script.id,
                  title: script.title,
                  category: script.category,
                  content: script.content,
                  tags: script.tags,
                },
              };
            }
            case 'alert': {
              const alert = data.alertsFor(advisorId).find((item) => item.id === id);
              if (!alert) return { status: 'not-found', scope, id };
              return {
                status: 'ok',
                scope,
                id,
                item: {
                  id: alert.id,
                  title: alert.title,
                  content: alert.title,
                  at: alert.at,
                  severity: alert.severity,
                  ruleIds: alert.ruleIds,
                },
              };
            }
            case 'rule': {
              const guard = guardApi();
              if (!guard) return { status: 'unconnected', scope };
              const rule = guard.getRule(id);
              if (!rule) return { status: 'not-found', scope, id };
              return {
                status: 'ok',
                scope,
                id,
                item: {
                  id: rule.id,
                  title: rule.name,
                  category: rule.kind,
                  content: [
                    `规则名：${rule.name}`,
                    `触发关键词：${rule.keywords.join('、')}`,
                    `风险等级：${riskLabel(rule.riskLevel)}`,
                    `处理动作：${rule.action}`,
                  ].join('\n'),
                },
              };
            }
          }
        },
        chronic: async (advisorId: string, patientId: string): Promise<AdvisorChronicResult> => {
          const api = patientApi();
          if (!api) return { status: 'unconnected' };
          const patient = api.getPatientAdmin(patientId);
          if (!patient || patient.deletedAt !== undefined) return { status: 'forbidden' };
          if (!ownsPatient(advisorId, patient)) return { status: 'forbidden' };
          const profile = api.getChronicProfile(patientId);
          const shown = displayNameOf(patient);
          const hasRecord =
            profile.conditions.length > 0 ||
            profile.measurements.length > 0 ||
            profile.medications.length > 0;
          if (!hasRecord) {
            return {
              status: 'ok',
              patientId,
              hasRecord: false,
              displayName: shown,
              conditions: [],
              medications: [],
              recentMeasurements: [],
            };
          }
          const recent = profile.measurements.slice(0, 3).map((measurement) => {
            const spec = CHRONIC_METRICS[measurement.metric];
            const context = measurement.context ? `（${measurement.context}）` : '';
            const source = CHRONIC_SOURCE_LABELS[measurement.source];
            return `${spec.label}：${formatMeasurementValue(measurement)}${context} · ` +
              `${shanghaiClock(measurement.measuredAt)} · ${source}`;
          });
          return {
            status: 'ok',
            patientId,
            hasRecord: true,
            displayName: shown,
            conditions: [...profile.conditions],
            medications: profile.medications.map((med) =>
              med.dose ? `${med.name} ${med.dose}` : med.name,
            ),
            recentMeasurements: recent,
            updatedAt: profile.updatedAt,
          };
        },
      };

      for (const tool of buildAdvisorToolDefinitions(handlers, { resolveAdvisorId })) {
        ctx.tools.register(tool);
      }

      const api: ZhibanAdvisorPort = {
        enabled: () => config.enabled && ctx.get<AdvisorWecomDataPort>('zhibanAdvisorData') !== undefined,
        handle: (advisorId, text) => agent!.handle(advisorId, text),
        reset: async (advisorId) => {
          const record = await sessions.reset(advisorId);
          log(`顾问 ${tailId(advisorId)} 重置会话 session=${record.sessionId}`);
          await data.sendText(advisorId, '已清空上下文，重新开始。');
        },
        handleSelection: async (advisorId, number) => {
          const list = agent!.lastList(advisorId);
          if (!list) {
            await data.sendText(
              advisorId,
              '没有可选的列表。直接用一句话说清要查的内容，比如「查一下复诊的话术」。',
            );
            return;
          }
          const item = list.items[number - 1];
          if (!item) {
            await data.sendText(advisorId, `上一条列表里没有第 ${number} 条。`);
            return;
          }
          const result = await handlers.get(advisorId, list.scope, item.id);
          const text = renderGet(result);
          await data.sendText(advisorId, text);
        },
      };
      ctx.provide('zhibanAdvisor', api);

      log('已就绪：advisor_overview / advisor_search / advisor_get / patient_chronic 已注册');

      return async () => {
        await store.flush();
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      await store.flush();
      await domain.close();
      throw error;
    }
  });
}
