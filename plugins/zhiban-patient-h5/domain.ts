/**
 * zhiban-patient-h5 的 DSH 领域存储（PH5-02 #231）。
 *
 * 表结构只校验定位字段，其余透传（沿用 zhiban-sidebar / zhiban-patient 模式），
 * 便于后续工作包（PH5-03..PH5-10）在同一域内新增实体，不改域版本。
 *
 * 契约：docs/PATIENT-H5-data-model.md §7。
 * PH5-02 落地的表：invitations / h5_sessions / h5_bindings / consents /
 * privacy_requests / h5_audits / h5_events / idempotency_records；
 * 其余表为后续工作包预留占位（health_plans / calendar_items / patient_records /
 * h5_media / followup_requests / content_articles / reminder_tasks /
 * patient_profile_entries）。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type {
  ConsentRecord,
  H5AuditRecord,
  H5BindingRecord,
  H5EventRecord,
  H5SessionRecord,
  IdempotencyRecord,
  InvitationRecord,
  PatientH5Backend,
  PatientH5Snapshot,
  PrivacyRequestRecord,
} from '../../src/p1/patient-h5.ts';

const locate = (fields: Record<string, z.ZodTypeAny>) =>
  domainTable(z.object(fields).passthrough());

export const patientH5Domain = defineDomain({
  name: 'zhiban_patient_h5',
  version: 1,
  tables: {
    // PH5-02 生效
    invitations: locate({ id: z.string().min(1) }),
    h5_sessions: locate({ id: z.string().min(1), tenantId: z.string().min(1) }),
    h5_bindings: locate({ id: z.string().min(1) }),
    consents: locate({ id: z.string().min(1) }),
    privacy_requests: locate({ id: z.string().min(1) }),
    h5_audits: locate({ at: z.number(), action: z.string().min(1) }),
    h5_events: locate({ at: z.number(), event: z.string().min(1) }),
    idempotency_records: locate({ key: z.string().min(1) }),
    // 后续工作包预留（占位，先声明避免域版本变更）
    patient_profile_entries: locate({ id: z.string().min(1) }),
    health_plans: locate({ id: z.string().min(1) }),
    calendar_items: locate({ id: z.string().min(1) }),
    patient_records: locate({ id: z.string().min(1) }),
    h5_media: locate({ id: z.string().min(1) }),
    followup_requests: locate({ id: z.string().min(1) }),
    content_articles: locate({ id: z.string().min(1) }),
    reminder_tasks: locate({ id: z.string().min(1) }),
  },
});

export type PatientH5DomainHandle = Domain<typeof patientH5Domain>;

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 域内键：同一租户同一患者同一 key 只保留一条 */
const idemKey = (tenantId: string, patientId: string, key: string): string =>
  `${tenantId}\u0000${patientId}\u0000${key}`;

export class DomainPatientH5Backend implements PatientH5Backend {
  private readonly invitations: AnyTable;
  private readonly sessions: AnyTable;
  private readonly bindings: AnyTable;
  private readonly consents: AnyTable;
  private readonly privacyRequests: AnyTable;
  private readonly audits: AnyTable;
  private readonly events: AnyTable;
  private readonly idempotency: AnyTable;
  private readonly tenantId: string;

  constructor(domain: PatientH5DomainHandle, tenantId: string) {
    this.invitations = domain.table('invitations') as unknown as AnyTable;
    this.sessions = domain.table('h5_sessions') as unknown as AnyTable;
    this.bindings = domain.table('h5_bindings') as unknown as AnyTable;
    this.consents = domain.table('consents') as unknown as AnyTable;
    this.privacyRequests = domain.table('privacy_requests') as unknown as AnyTable;
    this.audits = domain.table('h5_audits') as unknown as AnyTable;
    this.events = domain.table('h5_events') as unknown as AnyTable;
    this.idempotency = domain.table('idempotency_records') as unknown as AnyTable;
    this.tenantId = tenantId;
  }

  load(): PatientH5Snapshot {
    const values = <T>(table: AnyTable): T[] =>
      [...table.entries()].map(([, value]) => value as T);
    return {
      invitations: values<InvitationRecord>(this.invitations).filter(
        (item) => item.tenantId === this.tenantId,
      ),
      sessions: values<H5SessionRecord>(this.sessions).filter(
        (item) => item.tenantId === this.tenantId,
      ),
      bindings: values<H5BindingRecord>(this.bindings).filter(
        (item) => item.tenantId === this.tenantId,
      ),
      consents: values<ConsentRecord>(this.consents).filter(
        (item) => item.tenantId === this.tenantId,
      ),
      privacyRequests: values<PrivacyRequestRecord>(this.privacyRequests).filter(
        (item) => item.tenantId === this.tenantId,
      ),
    };
  }

  async loadIdempotency(patientId: string, key: string, now: number): Promise<unknown> {
    const hit = [...this.idempotency.entries()].find(([id, value]) => {
      if (id !== idemKey(this.tenantId, patientId, key)) return false;
      const record = value as IdempotencyRecord;
      return now - record.at <= IDEMPOTENCY_WINDOW_MS;
    });
    return hit ? (hit[1] as IdempotencyRecord).response : undefined;
  }

  async putInvitation(record: InvitationRecord): Promise<void> {
    await this.invitations.put(record.id, record);
  }

  async putSession(record: H5SessionRecord): Promise<void> {
    await this.sessions.put(record.id, record);
  }

  async putBinding(record: H5BindingRecord): Promise<void> {
    await this.bindings.put(record.id, record);
  }

  async putConsent(record: ConsentRecord): Promise<void> {
    await this.consents.put(record.id, record);
  }

  async putPrivacyRequest(record: PrivacyRequestRecord): Promise<void> {
    await this.privacyRequests.put(record.id, record);
  }

  async appendAudit(record: H5AuditRecord): Promise<void> {
    await this.audits.put(`${record.at}_${record.action}_${record.targetId ?? 'none'}`, record);
  }

  async appendEvent(record: H5EventRecord): Promise<void> {
    await this.events.put(`${record.at}_${record.id}`, record);
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.idempotency.put(idemKey(record.tenantId, record.patientId, record.key), record);
  }
}
