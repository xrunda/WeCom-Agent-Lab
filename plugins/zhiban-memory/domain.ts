/**
 * zhiban-memory 的 DSH 领域存储（#35）。
 *
 * 表 schema 只校验定位字段，其余透传，便于后续字段演进。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { MemoryBackend, MemoryRecord } from '../../src/p1/memory.ts';
import type { AuditEvent } from '../../src/c2/types.ts';

export const memoryDomain = defineDomain({
  name: 'zhiban_memory',
  version: 1,
  tables: {
    memories: domainTable(z.object({ id: z.string().min(1), patientId: z.string().min(1) }).passthrough()),
    audit: domainTable(z.object({ at: z.number(), action: z.string().min(1) }).passthrough()),
  },
});

export type MemoryDomainHandle = Domain<typeof memoryDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

export class DomainMemoryBackend implements MemoryBackend {
  private readonly memories: AnyTable;

  constructor(domain: MemoryDomainHandle) {
    this.memories = domain.table('memories') as unknown as AnyTable;
  }

  load(): MemoryRecord[] {
    return [...this.memories.entries()].map(([, value]) => value as MemoryRecord);
  }

  put(record: MemoryRecord): Promise<void> {
    return this.memories.put(record.id, record);
  }
}

/** 审计单独一张表；插件卸载前由 index.ts 写入 */
export function memoryAuditTable(domain: MemoryDomainHandle): {
  put(key: string, value: AuditEvent): Promise<void>;
} {
  return domain.table('audit') as unknown as {
    put(key: string, value: AuditEvent): Promise<void>;
  };
}
