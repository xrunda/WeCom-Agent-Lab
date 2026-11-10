/**
 * zhiban-patient 的 DSH 领域存储（#33）。
 *
 * 沿用 C2 的「内存镜像 + 串行落盘」模型：路由判定是同步的，
 * Domain 只负责持久化。表 schema 只校验定位字段，其余透传，
 * 便于后续字段演进。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { AuditEvent } from '../../src/c2/types.ts';
import type {
  PatientSnapshot,
  PatientStoreBackend,
  PatientTable,
} from '../../src/p1/patient-store.ts';
import type {
  AdvisorRecord,
  GroupBinding,
  GroupMember,
  ManagedGroup,
  Patient,
  PatientSessionRecord,
} from '../../src/p1/types.ts';
import type { MealLogRecord } from '../../src/p1/vision.ts';

export const patientDomain = defineDomain({
  name: 'zhiban_patient',
  version: 1,
  tables: {
    advisors: domainTable(z.object({ id: z.string().min(1) }).passthrough()),
    groups: domainTable(z.object({ id: z.string().min(1), roomId: z.string().min(1) }).passthrough()),
    members: domainTable(z.object({ id: z.string().min(1), groupId: z.string().min(1) }).passthrough()),
    bindings: domainTable(z.object({ id: z.string().min(1), groupId: z.string().min(1) }).passthrough()),
    patients: domainTable(z.object({ id: z.string().min(1) }).passthrough()),
    sessions: domainTable(z.object({ patientId: z.string().min(1) }).passthrough()),
    meal_logs: domainTable(
      z.object({ id: z.string().min(1), patientId: z.string().min(1) }).passthrough(),
    ),
    stats: domainTable(z.object({ turns: z.number() }).passthrough()),
    audit: domainTable(z.object({ at: z.number(), action: z.string().min(1) }).passthrough()),
  },
});

export type PatientDomainHandle = Domain<typeof patientDomain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class DomainPatientBackend implements PatientStoreBackend {
  private readonly tables: Record<PatientTable, AnyTable>;

  constructor(domain: PatientDomainHandle) {
    this.tables = {
      advisors: domain.table('advisors') as unknown as AnyTable,
      groups: domain.table('groups') as unknown as AnyTable,
      members: domain.table('members') as unknown as AnyTable,
      bindings: domain.table('bindings') as unknown as AnyTable,
      patients: domain.table('patients') as unknown as AnyTable,
      sessions: domain.table('sessions') as unknown as AnyTable,
      mealLogs: domain.table('meal_logs') as unknown as AnyTable,
      stats: domain.table('stats') as unknown as AnyTable,
      audit: domain.table('audit') as unknown as AnyTable,
    };
  }

  load(): PatientSnapshot {
    const values = <T>(table: PatientTable): T[] =>
      [...this.tables[table].entries()].map(([, value]) => value as T);

    const stats = values<Partial<PatientSnapshot['stats']>>('stats')[0];
    return {
      advisors: values<AdvisorRecord>('advisors'),
      groups: values<ManagedGroup>('groups'),
      members: values<GroupMember>('members'),
      bindings: values<GroupBinding>('bindings'),
      patients: values<Patient>('patients'),
      sessions: values<PatientSessionRecord>('sessions'),
      mealLogs: values<MealLogRecord>('mealLogs'),
      stats,
      audits: values<AuditEvent>('audit'),
    };
  }

  put(table: PatientTable, key: string, value: unknown): Promise<void> {
    return this.tables[table].put(key, value);
  }

  delete(table: PatientTable, key: string): Promise<boolean> {
    return this.tables[table].delete(key);
  }
}
