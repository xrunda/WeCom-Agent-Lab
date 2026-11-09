/**
 * zhiban-knowledge 的 DSH 领域存储（#38）。
 *
 * tables:
 * - entries 知识条目（软删除）
 * - audit   审计事件
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { AuditEvent } from '../../src/c2/types.ts';
import type { KnowledgeBackend, KnowledgeRecord } from '../../src/p1/knowledge.ts';

export const knowledgeDomain = defineDomain({
  name: 'zhiban_knowledge',
  version: 1,
  tables: {
    entries: domainTable(z.object({ id: z.string().min(1), category: z.string() }).passthrough()),
    audit: domainTable(z.object({ at: z.number(), action: z.string().min(1) }).passthrough()),
  },
});

export type KnowledgeDomainHandle = Domain<typeof knowledgeDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

export class DomainKnowledgeBackend implements KnowledgeBackend {
  private readonly entries: AnyTable;
  private readonly audits: AnyTable;

  constructor(domain: KnowledgeDomainHandle) {
    this.entries = domain.table('entries') as unknown as AnyTable;
    this.audits = domain.table('audit') as unknown as AnyTable;
  }

  load(): KnowledgeRecord[] {
    return [...this.entries.entries()].map(([, value]) => value as KnowledgeRecord);
  }

  put(record: KnowledgeRecord): Promise<void> {
    return this.entries.put(record.id, record);
  }

  appendAudit(event: AuditEvent): Promise<void> {
    const key = `${event.at}_${event.action}_${event.target}`;
    return this.audits.put(key, event).then(() => undefined);
  }
}
