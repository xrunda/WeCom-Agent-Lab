/**
 * zhiban-sidebar DSH 插件入口（#146 / #147）。
 *
 * 两件事：
 * 1. 接收 zhiban-wecom 观察到的存档消息，维护「待回复」索引；
 * 2. 在 `/zhiban/sidebar` 下提供侧边栏自己的接口（不入控制台路由）。
 *
 * 不生成草稿、不推送、不写控制台页面。插件可独立装载：
 * 未安装时 zhiban-wecom 的观察调用会静默跳过。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import type { AuditEvent } from '../../src/c2/types.ts';
import { SidebarService } from '../../src/p1/sidebar.ts';
import type {
  ObserveResult,
  PendingItem,
  PendingManualAction,
  SidebarMessageInput,
} from '../../src/p1/sidebar.ts';
import { buildSidebarContext } from '../../src/p1/sidebar-view.ts';
import type {
  SidebarAdvisor,
  SidebarDraftRef,
  SidebarPatientRef,
} from '../../src/p1/sidebar-view.ts';

import { parseSidebarConfig, retentionMs } from './config.ts';
import { DomainSidebarBackend, sidebarDomain } from './domain.ts';
import { registerSidebarHttp } from './http.ts';
import type { SidebarClientEvent, SidebarHttpResponse, SidebarWebServer } from './http.ts';
import { WecomOAuthClient } from './wecom-oauth.ts';

export const name = 'zhiban-sidebar';

/** storage-domain / webServer 由宿主提供 */
export const inject = ['storageDomain', 'webServer'];

type EffectCleanup = void | (() => void | Promise<void>);

export interface DshSidebarContext {
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
  webServer: SidebarWebServer;
}

/** 提供给 zhiban-wecom 与接口层 */
export interface SidebarRuntimeApi {
  observe(input: SidebarMessageInput): ObserveResult;
  openItems(convKey: string): PendingItem[];
  recentlyClosed(convKey: string, limit?: number): PendingItem[];
  get(id: string): PendingItem | undefined;
  lastObservedAt(convKey: string): number | undefined;
  close(id: string, reason: PendingManualAction, actor: string): PendingItem | undefined;
  /** 埋点：只上报事件名与 id，不带正文 */
  reportEvent(type: SidebarClientEvent, itemId?: string): void;
  allItems(): PendingItem[];
  prune(now?: number): void;
  flush(): Promise<void>;
}

/** zhiban-wecom 暴露的群绑定（只读副本） */
interface WecomAdminLike {
  listGroups(): Array<{
    roomId: string;
    chatId?: string;
    name: string;
    advisorId?: string;
    status?: string;
  }>;
  /** #149：已生成、未发出的草稿；群服务未就绪时返回空 */
  latestSidebarDraft?(roomId: string, since: number): SidebarDraftRef | undefined;
}

/** zhiban-patient 暴露给控制台的只读患者记录 */
type PatientRecordLike = {
  id: string;
  displayName: string;
  tags: string[];
  consent: string;
  identityStatus?: 'pending' | 'confirmed';
  lastActiveAt?: number;
  advisorId?: string;
};

/** zhiban-patient 暴露给控制台的只读视图 */
interface PatientApiLike {
  listGroups(): Array<{ roomId: string; patientIds: string[] }>;
  getPatientAdmin(id: string): PatientRecordLike | undefined;
  listPatients(): Array<{ id: string; externalUserId?: string; displayName: string }>;
  listAdvisors(): Array<{
    id: string;
    name: string;
    wecomUserId?: string;
    status?: string;
  }>;
}

/** 患者记录 → 侧边栏速览引用；群（按 id）与单聊（按外部 id）共用一份映射 */
function toPatientRef(record: PatientRecordLike | undefined): SidebarPatientRef | undefined {
  if (!record) return undefined;
  return {
    id: record.id,
    displayName: record.displayName,
    tags: record.tags,
    consent: record.consent,
    ...(record.identityStatus ? { identityStatus: record.identityStatus } : {}),
    ...(record.lastActiveAt !== undefined ? { lastActiveAt: record.lastActiveAt } : {}),
    ...(record.advisorId ? { advisorId: record.advisorId } : {}),
  };
}

function tailId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 2)}…${id.slice(-6)}`;
}

export function apply(ctx: DshSidebarContext, rawConfig: unknown): void {
  const config = parseSidebarConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-sidebar] ${line}`);

  log(
    `加载配置：租户=${config.tenantId} 机器人=${config.botUserIds.length} 个 ` +
      `鉴权=${config.sessionSecret ? '已配置' : '未配置（接口返回 401）'}`,
  );

  const oauth = new WecomOAuthClient({
    ...(config.corpId ? { corpId: config.corpId } : {}),
    ...(config.agentId ? { agentId: config.agentId } : {}),
    ...(config.agentSecret ? { agentSecret: config.agentSecret } : {}),
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    log,
  });
  log(`企微登录：${oauth.configured ? '已配置' : '未配置（侧边栏无法登录）'}`);

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(sidebarDomain);
    const backend = new DomainSidebarBackend(domain);

    try {
      const service = new SidebarService({
        backend,
        mergeWindowMs: config.mergeWindowMs,
        seenRetentionMs: retentionMs(config.seenRetentionDays),
        closedRetentionMs: retentionMs(config.closedRetentionDays),
        botUserIds: config.botUserIds,
        onAudit: (event: AuditEvent) => {
          ctx.emit('audit', event);
        },
        // 埋点与审计分开：埋点用于产品统计，允许丢失，绝不带正文
        onMetric: (metric) => {
          ctx.emit('sidebar.metric', metric);
        },
        onPersistError: (error) => {
          // 存储失败不影响判定：内存里仍然是正确的，重启后可能少一条
          log(`待回复存储写入失败：${error.message}`);
          ctx.emit('alert.created', {
            kind: 'PERSIST_FAILED',
            message: `待回复索引写入失败：${error.message}`,
            at: Date.now(),
          });
        },
      });

      const api: SidebarRuntimeApi = {
        observe: (input) => service.observe(input),
        openItems: (convKey) => service.openItems(convKey),
        recentlyClosed: (convKey, limit) => service.recentlyClosed(convKey, limit),
        get: (id) => service.get(id),
        lastObservedAt: (convKey) => service.lastObservedAt(convKey),
        close: (id, reason, actor) => service.close(id, reason, actor),
        reportEvent: (type, itemId) => {
          ctx.emit('sidebar.metric', {
            type,
            ...(itemId ? { itemId } : {}),
            at: Date.now(),
          });
        },
        allItems: () => service.allItems(),
        prune: (now) => service.prune(now),
        flush: () => service.flush(),
      };
      ctx.provide('zhibanSidebar', api);

      // 顾问身份来自患者域的顾问名册：只有在职（active）成员签发会话，
      // 侧边栏内部再按「群负责人」二次收窄可见范围。
      // wecomUserId 带给视图：单聊会话键用登录顾问自己的 userid 构造（#159）
      const advisorView = (
        record: { id: string; wecomUserId?: string; status?: string } | undefined,
      ): SidebarAdvisor | undefined => {
        if (!record) return undefined;
        if (record.status !== undefined && record.status !== 'active') return undefined;
        return { id: record.id, permissions: ['patient.read'], wecomUserId: record.wecomUserId };
      };

      // 侧边栏接口：权限与会话令牌在这里校验；数据依赖懒加载，
      // zhiban-patient / zhiban-wecom 晚于本插件就绪也能查
      registerSidebarHttp(ctx.webServer, {
        api,
        ...(config.sessionSecret ? { sessionSecret: config.sessionSecret } : {}),
        oauth,
        ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
        sessionTtlMs: config.sessionTtlMs,
        log,
        resolveAdvisor: (wecomUserId) =>
          advisorView(
            ctx
              .get<PatientApiLike>('zhibanPatient')
              ?.listAdvisors()
              .find((item) => item.wecomUserId === wecomUserId),
          ),
        // #159 会话路径只有 advisorId：回名册补齐 wecomUserId，单聊才能构造自己的会话键
        resolveAdvisorById: (advisorId) =>
          advisorView(
            ctx
              .get<PatientApiLike>('zhibanPatient')
              ?.listAdvisors()
              .find((item) => item.id === advisorId),
          ),
        buildContext: (advisor: SidebarAdvisor, query: URLSearchParams) => {
          const admin = ctx.get<WecomAdminLike>('zhibanWecomAdmin');
          const patient = ctx.get<PatientApiLike>('zhibanPatient');
          return buildSidebarContext(
            {
              openItems: (convKey) => api.openItems(convKey),
              recentlyClosed: (convKey, limit) => api.recentlyClosed(convKey, limit),
              lastObservedAt: (convKey) => api.lastObservedAt(convKey),
              listGroups: () => admin?.listGroups() ?? [],
              patientIdsForRoom: (roomId) =>
                patient?.listGroups().find((group) => group.roomId === roomId)?.patientIds ?? [],
              getPatient: (id) => toPatientRef(patient?.getPatientAdmin(id)),
              patientNameFor: (externalUserId) =>
                patient
                  ?.listPatients()
                  .find((item) => item.externalUserId === externalUserId)?.displayName,
              // #159 单聊速览：按外部联系人 id 找患者档案
              patientForExternal: (externalUserId) => {
                const record = patient
                  ?.listPatients()
                  .find((item) => item.externalUserId === externalUserId);
                return record ? toPatientRef(patient?.getPatientAdmin(record.id)) : undefined;
              },
              getAdvisorName: (advisorId) =>
                patient?.listAdvisors().find((item) => item.id === advisorId)?.name,
              // 只读：草稿由患者运行时生成，侧边栏不触发模型调用
              ...(admin?.latestSidebarDraft
                ? {
                    latestDraft: (roomId: string, since: number) =>
                      admin.latestSidebarDraft?.(roomId, since),
                  }
                : {}),
            },
            advisor,
            {
              ...(query.get('chatId') ? { chatId: query.get('chatId')! } : {}),
              ...(query.get('externalUserId')
                ? { externalUserId: query.get('externalUserId')! }
                : {}),
              // 仅内部关闭路径使用；GET 路由会剥掉这个参数
              ...(query.get('roomId') ? { roomId: query.get('roomId')! } : {}),
            },
          );
        },
      });

      const open = service.allItems().filter((item) => item.status === 'open').length;
      log(`已就绪：开放待回复 ${open} 条，接口前缀 /zhiban/sidebar`);

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

/** 仅用于日志与测试：不暴露正文 */
export function describeItem(item: PendingItem): string {
  return `${item.id} conv=${tailId(item.convKey)} customer=${tailId(item.customerId)} ` +
    `status=${item.status} count=${item.messageCount}`;
}

export type { SidebarHttpResponse };
