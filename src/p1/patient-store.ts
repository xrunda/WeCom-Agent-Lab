/**
 * 患者域存储（#33）。
 *
 * C2 的 Store 是同步读写的；这里沿用同样的约定：读取走内存镜像，
 * 写入同步返回，后台按顺序落盘（DSH storage-domain）。这样路由判定
 * 不会因为 await 产生「刚改成 collect_only 还漏进一条」的窗口。
 */
import type { AuditEvent } from '../c2/types.ts';
import type {
  AdvisorRecord,
  AgentStats,
  GroupBinding,
  GroupMember,
  ManagedGroup,
  Patient,
  PatientSessionRecord,
} from './types.ts';

export interface PatientSnapshot {
  advisors: AdvisorRecord[];
  groups: ManagedGroup[];
  members: GroupMember[];
  bindings: GroupBinding[];
  patients: Patient[];
  sessions: PatientSessionRecord[];
  stats?: Partial<AgentStats>;
  audits?: AuditEvent[];
}

export type PatientTable =
  | 'advisors'
  | 'groups'
  | 'members'
  | 'bindings'
  | 'patients'
  | 'sessions'
  | 'stats'
  | 'audit';

export interface PatientStoreBackend {
  load(): PatientSnapshot;
  put(table: PatientTable, key: string, value: unknown): Promise<void>;
  delete?(table: PatientTable, key: string): Promise<boolean>;
}

export interface PatientStoreOptions {
  backend?: PatientStoreBackend;
  /** 持久化失败回调；生产环境用于发 PERSIST_FAILED 告警 */
  onPersistError?: (error: Error) => void;
}

function idNumber(id: string, prefix: string): number {
  if (!id.startsWith(prefix)) return 0;
  const value = Number(id.slice(prefix.length));
  return Number.isFinite(value) ? value : 0;
}

function maxId(ids: string[], prefix: string): number {
  let max = 0;
  for (const id of ids) max = Math.max(max, idNumber(id, prefix));
  return max;
}

export class MemoryPatientStore {
  private readonly advisors = new Map<string, AdvisorRecord>();
  private readonly groups = new Map<string, ManagedGroup>();
  private readonly members = new Map<string, GroupMember>();
  private readonly bindings = new Map<string, GroupBinding>();
  private readonly patients = new Map<string, Patient>();
  private readonly sessions = new Map<string, PatientSessionRecord>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly backend?: PatientStoreBackend;
  private readonly onPersistError?: (error: Error) => void;
  private chain: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  private seq = {
    adv: 0,
    grp: 0,
    gm: 0,
    gbd: 0,
    pat: 0,
  };

  private counts: AgentStats = {
    turns: 0,
    replies: 0,
    skips: 0,
    fallbacks: 0,
    timeouts: 0,
    errors: 0,
  };

  constructor(options: PatientStoreOptions = {}) {
    this.backend = options.backend;
    this.onPersistError = options.onPersistError;
    if (!this.backend) return;

    const snapshot = this.backend.load();
    for (const advisor of snapshot.advisors) this.advisors.set(advisor.id, advisor);
    for (const group of snapshot.groups) this.groups.set(group.id, group);
    for (const member of snapshot.members) this.members.set(member.id, member);
    for (const binding of snapshot.bindings) this.bindings.set(binding.id, binding);
    for (const patient of snapshot.patients) this.patients.set(patient.id, patient);
    for (const session of snapshot.sessions) this.sessions.set(session.patientId, session);
    if (snapshot.stats) this.counts = { ...this.counts, ...snapshot.stats };
    if (snapshot.audits) this.auditEvents.push(...snapshot.audits);

    this.seq.adv = maxId([...this.advisors.keys()], 'adv_');
    this.seq.grp = maxId([...this.groups.keys()], 'grp_');
    this.seq.gm = maxId([...this.members.keys()], 'gm_');
    this.seq.gbd = maxId([...this.bindings.keys()], 'gbd_');
    this.seq.pat = maxId([...this.patients.keys()], 'pat_');
  }

  nextId(kind: 'adv' | 'grp' | 'gm' | 'gbd' | 'pat'): string {
    this.seq[kind] += 1;
    return `${kind}_${this.seq[kind]}`;
  }

  // ---------- advisor ----------

  saveAdvisor(advisor: AdvisorRecord): void {
    this.advisors.set(advisor.id, advisor);
    this.persist('advisors', advisor.id, advisor);
  }

  getAdvisor(id: string): AdvisorRecord | undefined {
    return this.advisors.get(id);
  }

  getAdvisorByWecomUserId(userId: string): AdvisorRecord | undefined {
    for (const advisor of this.advisors.values()) {
      if (advisor.wecomUserId === userId) return advisor;
    }
    return undefined;
  }

  listAdvisors(): AdvisorRecord[] {
    return [...this.advisors.values()];
  }

  // ---------- group ----------

  saveGroup(group: ManagedGroup): void {
    this.groups.set(group.id, group);
    this.persist('groups', group.id, group);
  }

  getGroup(id: string): ManagedGroup | undefined {
    return this.groups.get(id);
  }

  getGroupByRoomId(roomId: string): ManagedGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.roomId === roomId) return group;
    }
    return undefined;
  }

  listGroups(): ManagedGroup[] {
    return [...this.groups.values()];
  }

  // ---------- member ----------

  saveMember(member: GroupMember): void {
    this.members.set(member.id, member);
    this.persist('members', member.id, member);
  }

  getMember(id: string): GroupMember | undefined {
    return this.members.get(id);
  }

  listMembers(groupId: string): GroupMember[] {
    return [...this.members.values()].filter((m) => m.groupId === groupId);
  }

  findMember(groupId: string, externalUserId: string): GroupMember | undefined {
    return this.listMembers(groupId).find((m) => m.externalUserId === externalUserId);
  }

  // ---------- binding ----------

  saveBinding(binding: GroupBinding): void {
    this.bindings.set(binding.id, binding);
    this.persist('bindings', binding.id, binding);
  }

  listBindingsByGroup(groupId: string): GroupBinding[] {
    return [...this.bindings.values()].filter((b) => b.groupId === groupId && b.deletedAt === undefined);
  }

  listBindingsByPatient(patientId: string): GroupBinding[] {
    return [...this.bindings.values()].filter(
      (b) => b.patientId === patientId && b.deletedAt === undefined,
    );
  }

  // ---------- patient ----------

  savePatient(patient: Patient): void {
    this.patients.set(patient.id, patient);
    this.persist('patients', patient.id, patient);
  }

  getPatient(id: string): Patient | undefined {
    return this.patients.get(id);
  }

  findPatientByExternalId(externalUserId: string): Patient | undefined {
    for (const patient of this.patients.values()) {
      if (patient.externalUserId === externalUserId && patient.deletedAt === undefined) return patient;
    }
    return undefined;
  }

  listPatients(): Patient[] {
    return [...this.patients.values()];
  }

  // ---------- session ----------

  saveSession(session: PatientSessionRecord): void {
    this.sessions.set(session.patientId, session);
    this.persist('sessions', session.patientId, session);
  }

  getSession(patientId: string): PatientSessionRecord | undefined {
    return this.sessions.get(patientId);
  }

  listSessions(): PatientSessionRecord[] {
    return [...this.sessions.values()];
  }

  // ---------- stats ----------

  bumpStat(key: keyof AgentStats, by = 1): void {
    this.counts[key] += by;
    this.persist('stats', 'agent', this.counts);
  }

  stats(): AgentStats {
    return { ...this.counts };
  }

  // ---------- audit ----------

  appendAudit(event: AuditEvent): void {
    this.auditEvents.push(event);
    if (this.auditEvents.length > 500) this.auditEvents.shift();
    this.persist('audit', `audit_${event.at}_${this.auditEvents.length}`, event);
  }

  listAudit(): AuditEvent[] {
    return [...this.auditEvents];
  }

  // ---------- persistence ----------

  snapshot(): PatientSnapshot {
    return {
      advisors: [...this.advisors.values()],
      groups: [...this.groups.values()],
      members: [...this.members.values()],
      bindings: [...this.bindings.values()],
      patients: [...this.patients.values()],
      sessions: [...this.sessions.values()],
      stats: { ...this.counts },
      audits: [...this.auditEvents],
    };
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  lastPersistError(): Error | undefined {
    return this.lastError;
  }

  private persist(table: PatientTable, key: string, value: unknown): void {
    const backend = this.backend;
    if (!backend) return;
    this.chain = this.chain
      .then(() => backend.put(table, key, value))
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.lastError = err;
        this.onPersistError?.(err);
      });
  }
}
