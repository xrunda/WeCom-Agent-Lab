/**
 * zhiban-wecom 的 DSH 领域存储（#32）。
 *
 * DSH 0.2.1-rc.5 只随包提供 `dsh-storage-json` 后端；`storage-domain`
 * 把具体介质藏在 `ctx.storageDomain` 后面。因此这里不直接依赖 sqlite，
 * 而是实现 `Store` 接口并用 storage-domain 持久化；后续换后端不需要改
 * C2 业务代码。
 *
 * 读写模型：
 * - 读取同步来自内存镜像（与 `MemoryStore` 语义一致，队列逻辑不需要 await）。
 * - 写入先更新镜像，再串行落到 storage-domain；`flush()` 等待全部落盘。
 * - 日志和持久化错误都不包含消息正文。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { Store } from '../../src/c2/ports.ts';
import type {
  Advisor,
  Alert,
  AuditEvent,
  CustomerGroup,
  Draft,
  DraftStatus,
} from '../../src/c2/types.ts';

/**
 * 领域名与表名必须匹配 DSH 的 `[a-z][a-z0-9_]*`。
 * 记录 schema 只校验用于定位/索引的关键字段，其余字段透传，
 * 避免 C2 领域模型新增字段时触发 `invalid-record`。
 */
export const wecomDomain = defineDomain({
  name: 'zhiban_wecom',
  version: 1,
  tables: {
    advisors: domainTable(z.object({ id: z.string().min(1) }).passthrough()),
    groups: domainTable(z.object({ roomId: z.string().min(1) }).passthrough()),
    drafts: domainTable(z.object({ id: z.string().min(1) }).passthrough()),
    active: domainTable(
      z.object({ advisorId: z.string().min(1), draftId: z.string().min(1) }).passthrough(),
    ),
    audit: domainTable(
      z.object({ at: z.number(), action: z.string().min(1) }).passthrough(),
    ),
    alerts: domainTable(
      z.object({ kind: z.string().min(1), at: z.number() }).passthrough(),
    ),
    meta: domainTable(z.object({ value: z.unknown() }).passthrough()),
  },
});

export type WecomDomainHandle = Domain<typeof wecomDomain>;

export type StoreTable = 'advisors' | 'groups' | 'drafts' | 'active' | 'audit' | 'alerts' | 'meta';

interface AnyTable {
  get(key: string): unknown;
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface StoreSnapshot {
  advisors: Array<[string, Advisor]>;
  groups: Array<[string, CustomerGroup]>;
  drafts: Array<[string, Draft]>;
  active: Array<[string, string]>;
  audit: Array<[string, AuditEvent]>;
  alerts: Array<[string, Alert]>;
  meta: Array<[string, unknown]>;
}

/** Store 的持久化后端；测试里用内存实现，线上用 storage-domain 实现 */
export interface StoreBackend {
  loadSnapshot(): StoreSnapshot;
  put(table: StoreTable, key: string, value: unknown): Promise<void>;
  delete(table: StoreTable, key: string): Promise<void>;
}

export class DomainStoreBackend implements StoreBackend {
  private readonly tables: Record<StoreTable, AnyTable>;

  constructor(domain: WecomDomainHandle) {
    this.tables = {
      advisors: domain.table('advisors') as unknown as AnyTable,
      groups: domain.table('groups') as unknown as AnyTable,
      drafts: domain.table('drafts') as unknown as AnyTable,
      active: domain.table('active') as unknown as AnyTable,
      audit: domain.table('audit') as unknown as AnyTable,
      alerts: domain.table('alerts') as unknown as AnyTable,
      meta: domain.table('meta') as unknown as AnyTable,
    };
  }

  loadSnapshot(): StoreSnapshot {
    const pairs = (table: StoreTable): Array<[string, unknown]> => [
      ...this.tables[table].entries(),
    ];
    const advisors = pairs('advisors').map(([key, value]) => [key, value as Advisor] as [string, Advisor]);
    const groups = pairs('groups').map(([key, value]) => [key, value as CustomerGroup] as [string, CustomerGroup]);
    const drafts = pairs('drafts').map(([key, value]) => [key, value as Draft] as [string, Draft]);
    const active = pairs('active').map(
      ([key, value]) => [key, (value as { draftId: string }).draftId] as [string, string],
    );
    const audit = pairs('audit').map(([key, value]) => [key, value as AuditEvent] as [string, AuditEvent]);
    const alerts = pairs('alerts').map(([key, value]) => [key, value as Alert] as [string, Alert]);
    const meta = pairs('meta').map(
      ([key, value]) => [key, (value as { value: unknown }).value] as [string, unknown],
    );
    return { advisors, groups, drafts, active, audit, alerts, meta };
  }

  put(table: StoreTable, key: string, value: unknown): Promise<void> {
    return this.tables[table].put(key, value);
  }

  delete(table: StoreTable, key: string): Promise<void> {
    return this.tables[table].delete(key).then(() => undefined);
  }
}

/** 测试用内存后端：行为与 storage-domain 一致，写入立即可读 */
export class MemoryStoreBackend implements StoreBackend {
  readonly data = new Map<StoreTable, Map<string, unknown>>([
    ['advisors', new Map()],
    ['groups', new Map()],
    ['drafts', new Map()],
    ['active', new Map()],
    ['audit', new Map()],
    ['alerts', new Map()],
    ['meta', new Map()],
  ]);

  loadSnapshot(): StoreSnapshot {
    const pairs = (table: StoreTable): Array<[string, unknown]> => [
      ...(this.data.get(table) ?? new Map<string, unknown>()).entries(),
    ];
    return {
      advisors: pairs('advisors') as Array<[string, Advisor]>,
      groups: pairs('groups') as Array<[string, CustomerGroup]>,
      drafts: pairs('drafts') as Array<[string, Draft]>,
      active: pairs('active').map(
        ([key, value]) => [key, (value as { draftId: string }).draftId] as [string, string],
      ),
      audit: pairs('audit') as Array<[string, AuditEvent]>,
      alerts: pairs('alerts') as Array<[string, Alert]>,
      meta: pairs('meta').map(
        ([key, value]) => [key, (value as { value: unknown }).value] as [string, unknown],
      ),
    };
  }

  async put(table: StoreTable, key: string, value: unknown): Promise<void> {
    this.data.get(table)?.set(key, structuredClone(value));
  }

  async delete(table: StoreTable, key: string): Promise<void> {
    this.data.get(table)?.delete(key);
  }
}

/**
 * 同步 Store + 串行异步持久化。
 * C2 的队列/状态机仍是同步 API，这里用镜像保证读取语义不变。
 */
export class DomainStore implements Store {
  private readonly advisors = new Map<string, Advisor>();
  private readonly groups = new Map<string, CustomerGroup>();
  private readonly drafts = new Map<string, Draft>();
  private readonly active = new Map<string, string>();
  private readonly audit: AuditEvent[] = [];
  private readonly alerts: Alert[] = [];
  private readonly meta = new Map<string, unknown>();

  private readonly backend: StoreBackend;
  private readonly onPersistError?: (error: Error) => void;

  private chain: Promise<void> = Promise.resolve();
  private auditSeq = 0;
  private alertSeq = 0;
  private persistError: Error | undefined;

  constructor(backend: StoreBackend, onPersistError?: (error: Error) => void) {
    this.backend = backend;
    this.onPersistError = onPersistError;
    const snapshot = backend.loadSnapshot();
    for (const [key, value] of snapshot.advisors) this.advisors.set(key, value);
    for (const [key, value] of snapshot.groups) this.groups.set(key, value);
    for (const [key, value] of snapshot.drafts) this.drafts.set(key, value);
    for (const [key, value] of snapshot.active) this.active.set(key, value);
    for (const [key, value] of snapshot.audit) {
      this.audit.push(value);
      this.auditSeq = Math.max(this.auditSeq, parseSeq(key));
    }
    for (const [key, value] of snapshot.alerts) {
      this.alerts.push(value);
      this.alertSeq = Math.max(this.alertSeq, parseSeq(key));
    }
    for (const [key, value] of snapshot.meta) this.meta.set(key, value);
  }

  /** 等待全部已排队的持久化写入 */
  flush(): Promise<void> {
    return this.chain;
  }

  lastPersistError(): Error | undefined {
    return this.persistError;
  }

  getMeta<T>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.meta.set(key, value);
    this.enqueue('meta', key, { value: structuredClone(value) });
  }

  saveAdvisor(advisor: Advisor): void {
    this.advisors.set(advisor.id, advisor);
    this.enqueue('advisors', advisor.id, advisor);
  }

  getAdvisor(id: string): Advisor | undefined {
    return this.advisors.get(id);
  }

  listAdvisors(): Advisor[] {
    return [...this.advisors.values()];
  }

  saveGroup(group: CustomerGroup): void {
    this.groups.set(group.roomId, group);
    this.enqueue('groups', group.roomId, group);
  }

  getGroup(roomId: string): CustomerGroup | undefined {
    return this.groups.get(roomId);
  }

  listGroups(): CustomerGroup[] {
    return [...this.groups.values()];
  }

  saveDraft(draft: Draft): void {
    this.drafts.set(draft.id, draft);
    this.enqueue('drafts', draft.id, draft);
  }

  getDraft(id: string): Draft | undefined {
    return this.drafts.get(id);
  }

  listDrafts(): Draft[] {
    return [...this.drafts.values()];
  }

  listQueued(advisorId: string, now: number): Draft[] {
    return [...this.drafts.values()]
      .filter((draft) => draft.advisorId === advisorId && draft.status === 'QUEUED' && draft.nextAttemptAt <= now)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  listDraftsByStatus(status: DraftStatus): Draft[] {
    return [...this.drafts.values()].filter((draft) => draft.status === status);
  }

  getActiveDraft(advisorId: string): string | undefined {
    return this.active.get(advisorId);
  }

  setActiveDraft(advisorId: string, draftId: string | undefined): void {
    if (draftId === undefined) {
      this.active.delete(advisorId);
      this.enqueue('active', advisorId, undefined, true);
      return;
    }
    this.active.set(advisorId, draftId);
    this.enqueue('active', advisorId, { advisorId, draftId });
  }

  appendAudit(event: AuditEvent): void {
    this.audit.push(event);
    const key = `audit_${event.at}_${++this.auditSeq}`;
    this.enqueue('audit', key, event);
  }

  listAudit(): AuditEvent[] {
    return [...this.audit];
  }

  emitAlert(alert: Alert): void {
    this.alerts.push(alert);
    const key = `alert_${alert.at}_${++this.alertSeq}`;
    this.enqueue('alerts', key, alert);
  }

  listAlerts(): Alert[] {
    return [...this.alerts];
  }

  private enqueue(table: StoreTable, key: string, value: unknown, remove = false): void {
    const snapshot = remove ? undefined : structuredClone(value);
    this.chain = this.chain.then(async () => {
      try {
        if (remove) await this.backend.delete(table, key);
        else await this.backend.put(table, key, snapshot);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.persistError = normalized;
        this.onPersistError?.(normalized);
      }
    });
  }
}

function parseSeq(key: string): number {
  const match = /_(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}
