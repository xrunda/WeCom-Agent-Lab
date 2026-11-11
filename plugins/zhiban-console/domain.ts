/**
 * zhiban-console 的 DSH 领域存储（#41）。
 *
 * 内存镜像由 ConsoleStore 维护，Domain 只负责落盘；schema 只校验定位字段，
 * 其余透传，便于后续按契约新增字段。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import { CONSOLE_TABLES, type ConsoleBackend, type ConsoleTable } from '../../src/p1/console-store.ts';

const table = () => domainTable(z.object({}).passthrough());

export const consoleDomain = defineDomain({
  name: 'zhiban_console',
  version: 1,
  tables: {
    tenants: table(),
    accounts: table(),
    sessions: table(),
    audits: table(),
    alerts: table(),
    sandbox_sessions: table(),
    sandbox_messages: table(),
    sandbox_drafts: table(),
    sandbox_verifications: table(),
    sandbox_events: table(),
    sandbox_memories: table(),
    sandbox_quota: table(),
    media: table(),
    // #120 话术库。新增表不改变已有表的落盘形状，因此无需提升 version。
    scripts: table(),
  },
});

export type ConsoleDomainHandle = Domain<typeof consoleDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class DomainConsoleBackend implements ConsoleBackend {
  private readonly tables: Record<ConsoleTable, AnyTable>;

  constructor(domain: ConsoleDomainHandle) {
    this.tables = Object.fromEntries(
      CONSOLE_TABLES.map((name) => [name, domain.table(name) as unknown as AnyTable]),
    ) as Record<ConsoleTable, AnyTable>;
  }

  load(tableName: ConsoleTable): unknown[] {
    return [...this.tables[tableName].entries()].map(([, value]) => value);
  }

  put(tableName: ConsoleTable, key: string, value: unknown): Promise<void> {
    return this.tables[tableName].put(key, value);
  }

  delete(tableName: ConsoleTable, key: string): Promise<boolean> {
    return this.tables[tableName].delete(key);
  }
}
