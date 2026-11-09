/**
 * zhiban-care 的 DSH 领域存储（#36）。
 *
 * 计划与审计分表；计划表只校验定位字段，便于字段演进。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { CareBackend, CarePlanRecord } from '../../src/p1/care.ts';
import type { AuditEvent } from '../../src/c2/types.ts';

export const careDomain = defineDomain({
  name: 'zhiban_care',
  version: 1,
  tables: {
    plans: domainTable(z.object({ id: z.string().min(1), patientId: z.string().min(1) }).passthrough()),
    audit: domainTable(z.object({ at: z.number(), action: z.string().min(1) }).passthrough()),
  },
});

export type CareDomainHandle = Domain<typeof careDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

export class DomainCareBackend implements CareBackend {
  private readonly plans: AnyTable;

  constructor(domain: CareDomainHandle) {
    this.plans = domain.table('plans') as unknown as AnyTable;
  }

  load(): CarePlanRecord[] {
    return [...this.plans.entries()].map(([, value]) => value as CarePlanRecord);
  }

  put(plan: CarePlanRecord): Promise<void> {
    return this.plans.put(plan.id, plan);
  }
}

export function careAuditTable(domain: CareDomainHandle): {
  put(key: string, value: AuditEvent): Promise<void>;
} {
  return domain.table('audit') as unknown as {
    put(key: string, value: AuditEvent): Promise<void>;
  };
}
