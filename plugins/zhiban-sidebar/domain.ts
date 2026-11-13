/**
 * zhiban-sidebar 的 DSH 领域存储（#146）。
 *
 * tables:
 * - pending 待回复条目（含已关闭，按保留期裁剪）
 * - seen    已见消息 id，用于幂等与重复投递
 * - audit   手动处理审计（不含正文）
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { AuditEvent } from '../../src/c2/types.ts';
import type { PendingItem, SidebarBackend } from '../../src/p1/sidebar.ts';

export const sidebarDomain = defineDomain({
  name: 'zhiban_sidebar',
  version: 1,
  tables: {
    pending: domainTable(z.object({ id: z.string().min(1) }).passthrough()),
    seen: domainTable(z.object({ msgid: z.string().min(1) }).passthrough()),
    audit: domainTable(z.object({ at: z.number(), action: z.string().min(1) }).passthrough()),
  },
});

export type SidebarDomainHandle = Domain<typeof sidebarDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class DomainSidebarBackend implements SidebarBackend {
  private readonly pending: AnyTable;
  private readonly seen: AnyTable;
  private readonly audits: AnyTable;

  constructor(domain: SidebarDomainHandle) {
    this.pending = domain.table('pending') as unknown as AnyTable;
    this.seen = domain.table('seen') as unknown as AnyTable;
    this.audits = domain.table('audit') as unknown as AnyTable;
  }

  loadItems(): PendingItem[] {
    return [...this.pending.entries()].map(([, value]) => value as PendingItem);
  }

  putItem(item: PendingItem): Promise<void> {
    return this.pending.put(item.id, item);
  }

  loadSeen(): Array<{ msgid: string; at: number }> {
    return [...this.seen.entries()].map(([, value]) => value as { msgid: string; at: number });
  }

  putSeen(msgid: string, at: number): Promise<void> {
    return this.seen.put(msgid, { msgid, at });
  }

  appendAudit(event: AuditEvent): Promise<void> {
    const key = `${event.at}_${event.action}_${event.target}`;
    return this.audits.put(key, event);
  }
}
