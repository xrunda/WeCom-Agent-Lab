/**
 * zhiban-sidebar DSH 插件入口（#146）。
 *
 * 只做一件事：接收 zhiban-wecom 观察到的存档消息，维护「待回复」索引。
 * 不生成草稿、不推送、不写控制台；查询与权限由后续接口层负责。
 *
 * 插件可独立装载：未安装时 zhiban-wecom 的观察调用会静默跳过。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import type { AuditEvent } from '../../src/c2/types.ts';
import { SidebarService } from '../../src/p1/sidebar.ts';
import type {
  ObserveResult,
  PendingItem,
  SidebarMessageInput,
} from '../../src/p1/sidebar.ts';

import { parseSidebarConfig, retentionMs } from './config.ts';
import { DomainSidebarBackend, sidebarDomain } from './domain.ts';

export const name = 'zhiban-sidebar';

/** storage-domain 由 dsh-storage-domain 插件提供 */
export const inject = ['storageDomain'];

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
}

/** 提供给 zhiban-wecom 与接口层 */
export interface SidebarRuntimeApi {
  observe(input: SidebarMessageInput): ObserveResult;
  openItems(convKey: string): PendingItem[];
  recentlyClosed(convKey: string, limit?: number): PendingItem[];
  get(id: string): PendingItem | undefined;
  close(id: string, reason: 'dismissed' | 'transferred', actor: string): PendingItem | undefined;
  allItems(): PendingItem[];
  prune(now?: number): void;
  flush(): Promise<void>;
}

function tailId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 2)}…${id.slice(-6)}`;
}

export function apply(ctx: DshSidebarContext, rawConfig: unknown): void {
  const config = parseSidebarConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-sidebar] ${line}`);

  log(`加载配置：租户=${config.tenantId} 机器人=${config.botUserIds.length} 个`);

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
        close: (id, reason, actor) => service.close(id, reason, actor),
        allItems: () => service.allItems(),
        prune: (now) => service.prune(now),
        flush: () => service.flush(),
      };
      ctx.provide('zhibanSidebar', api);

      const open = service.allItems().filter((item) => item.status === 'open').length;
      log(`已就绪：开放待回复 ${open} 条`);

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
