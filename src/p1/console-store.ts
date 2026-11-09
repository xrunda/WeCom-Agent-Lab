/**
 * #41 控制台领域存储：内存镜像 + 串行落盘。
 *
 * 读接口是同步的（认证与鉴权在请求线程内完成），写接口排队落盘。
 * 表名与 docs/P1-data-model.md §7 对齐；沙盒表用 sandbox_ 前缀。
 */
import { randomUUID } from 'node:crypto';

import type {
  AccountRecord,
  AlertRecord,
  ConsoleAuditEvent,
  SandboxDraft,
  SandboxEvent,
  SandboxMemory,
  SandboxMessage,
  SandboxQuota,
  SandboxSessionRecord,
  SandboxVerification,
  SessionRecord,
  TenantRecord,
} from './console-types.ts';

export type ConsoleTable =
  | 'tenants'
  | 'accounts'
  | 'sessions'
  | 'audits'
  | 'alerts'
  | 'sandbox_sessions'
  | 'sandbox_messages'
  | 'sandbox_drafts'
  | 'sandbox_verifications'
  | 'sandbox_events'
  | 'sandbox_memories'
  | 'sandbox_quota'
  | 'media';

export const CONSOLE_TABLES: readonly ConsoleTable[] = [
  'tenants',
  'accounts',
  'sessions',
  'audits',
  'alerts',
  'sandbox_sessions',
  'sandbox_messages',
  'sandbox_drafts',
  'sandbox_verifications',
  'sandbox_events',
  'sandbox_memories',
  'sandbox_quota',
  'media',
];

export interface ConsoleMediaRecord {
  id: string;
  tenantId: string;
  accountId: string;
  path: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  sandbox: boolean;
  createdAt: number;
}

export interface ConsoleBackend {
  load(table: ConsoleTable): unknown[];
  put(table: ConsoleTable, key: string, value: unknown): Promise<void>;
  delete(table: ConsoleTable, key: string): Promise<boolean>;
}

export class MemoryConsoleBackend implements ConsoleBackend {
  readonly tables = new Map<ConsoleTable, Map<string, unknown>>();

  private table(name: ConsoleTable): Map<string, unknown> {
    let found = this.tables.get(name);
    if (!found) {
      found = new Map();
      this.tables.set(name, found);
    }
    return found;
  }

  load(table: ConsoleTable): unknown[] {
    return [...this.table(table).values()];
  }

  async put(table: ConsoleTable, key: string, value: unknown): Promise<void> {
    this.table(table).set(key, value);
  }

  async delete(table: ConsoleTable, key: string): Promise<boolean> {
    return this.table(table).delete(key);
  }
}

function makeDefaultId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function newConsoleId(prefix: string): string {
  return makeDefaultId(prefix);
}

export interface ConsoleStoreOptions {
  backend: ConsoleBackend;
  now?: () => number;
  newId?: (prefix: string) => string;
  onPersistError?: (error: Error) => void;
}

export class ConsoleStore {
  private readonly backend: ConsoleBackend;
  private readonly now: () => number;
  readonly newId: (prefix: string) => string;
  private readonly onPersistError?: (error: Error) => void;
  private chain: Promise<void> = Promise.resolve();

  private readonly tenants = new Map<string, TenantRecord>();
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly audits: ConsoleAuditEvent[] = [];
  private readonly alerts = new Map<string, AlertRecord>();
  private readonly sandboxSessions = new Map<string, SandboxSessionRecord>();
  private readonly sandboxMessages = new Map<string, SandboxMessage>();
  private readonly sandboxDrafts = new Map<string, SandboxDraft>();
  private readonly sandboxVerifications = new Map<string, SandboxVerification>();
  private readonly sandboxEvents = new Map<string, SandboxEvent>();
  private readonly sandboxMemories = new Map<string, SandboxMemory>();
  private readonly sandboxQuota = new Map<string, SandboxQuota>();
  private readonly media = new Map<string, ConsoleMediaRecord>();
  private readonly auditKeys = new Set<string>();

  constructor(options: ConsoleStoreOptions) {
    this.backend = options.backend;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? makeDefaultId;
    this.onPersistError = options.onPersistError;

    for (const value of options.backend.load('tenants')) {
      const record = value as TenantRecord;
      this.tenants.set(record.id, record);
    }
    for (const value of options.backend.load('accounts')) {
      const record = value as AccountRecord;
      this.accounts.set(record.id, record);
    }
    for (const value of options.backend.load('sessions')) {
      const record = value as SessionRecord;
      this.sessions.set(record.tokenHash, record);
    }
    for (const value of options.backend.load('audits')) {
      const record = value as ConsoleAuditEvent;
      this.audits.push(record);
      this.auditKeys.add(record.id);
    }
    for (const value of options.backend.load('alerts')) {
      const record = value as AlertRecord;
      this.alerts.set(record.id, record);
    }
    for (const value of options.backend.load('sandbox_sessions')) {
      const record = value as SandboxSessionRecord;
      this.sandboxSessions.set(record.accountId, record);
    }
    for (const value of options.backend.load('sandbox_messages')) {
      const record = value as SandboxMessage;
      this.sandboxMessages.set(record.id, record);
    }
    for (const value of options.backend.load('sandbox_drafts')) {
      const record = value as SandboxDraft;
      this.sandboxDrafts.set(record.id, record);
    }
    for (const value of options.backend.load('sandbox_verifications')) {
      const record = value as SandboxVerification;
      this.sandboxVerifications.set(record.id, record);
    }
    for (const value of options.backend.load('sandbox_events')) {
      const record = value as SandboxEvent;
      this.sandboxEvents.set(record.id, record);
    }
    for (const value of options.backend.load('sandbox_memories')) {
      const record = value as SandboxMemory;
      this.sandboxMemories.set(record.id, record);
    }
    for (const value of options.backend.load('sandbox_quota')) {
      const record = value as SandboxQuota;
      this.sandboxQuota.set(`${record.accountId}:${record.day}`, record);
    }
    for (const value of options.backend.load('media')) {
      const record = value as ConsoleMediaRecord;
      this.media.set(record.id, record);
    }
  }

  // ---------- 租户 ----------

  getTenant(id: string): TenantRecord | undefined {
    return this.tenants.get(id);
  }

  listTenants(): TenantRecord[] {
    return [...this.tenants.values()];
  }

  saveTenant(record: TenantRecord): void {
    this.tenants.set(record.id, record);
    this.persist('tenants', record.id, record);
  }

  // ---------- 账号 ----------

  getAccount(id: string): AccountRecord | undefined {
    return this.accounts.get(id);
  }

  findAccountByUsername(username: string): AccountRecord | undefined {
    const needle = username.trim().toLowerCase();
    return [...this.accounts.values()].find(
      (account) => account.username.toLowerCase() === needle && account.deletedAt === undefined,
    );
  }

  listAccounts(): AccountRecord[] {
    return [...this.accounts.values()];
  }

  saveAccount(record: AccountRecord): void {
    this.accounts.set(record.id, record);
    this.persist('accounts', record.id, record);
  }

  // ---------- 会话 ----------

  getSession(tokenHash: string): SessionRecord | undefined {
    return this.sessions.get(tokenHash);
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  saveSession(record: SessionRecord): void {
    this.sessions.set(record.tokenHash, record);
    this.persist('sessions', record.tokenHash, record);
  }

  deleteSession(tokenHash: string): void {
    this.sessions.delete(tokenHash);
    this.persistDelete('sessions', tokenHash);
  }

  // ---------- 审计 ----------

  appendAudit(event: Omit<ConsoleAuditEvent, 'id' | 'at'> & { at?: number }): ConsoleAuditEvent {
    const record: ConsoleAuditEvent = {
      ...event,
      id: this.newId('aud'),
      at: event.at ?? this.now(),
    };
    if (this.auditKeys.has(record.id)) return record;
    this.auditKeys.add(record.id);
    this.audits.push(record);
    this.persist('audits', record.id, record);
    return record;
  }

  listAudits(): ConsoleAuditEvent[] {
    return [...this.audits];
  }

  // ---------- 告警 ----------

  getAlert(id: string): AlertRecord | undefined {
    return this.alerts.get(id);
  }

  listAlerts(): AlertRecord[] {
    return [...this.alerts.values()];
  }

  saveAlert(record: AlertRecord): void {
    this.alerts.set(record.id, record);
    this.persist('alerts', record.id, record);
  }

  // ---------- 沙盒 ----------

  getSandboxSession(accountId: string): SandboxSessionRecord | undefined {
    return this.sandboxSessions.get(accountId);
  }

  listSandboxSessions(): SandboxSessionRecord[] {
    return [...this.sandboxSessions.values()];
  }

  saveSandboxSession(record: SandboxSessionRecord): void {
    this.sandboxSessions.set(record.accountId, record);
    this.persist('sandbox_sessions', record.accountId, record);
  }

  listSandboxMessages(accountId: string): SandboxMessage[] {
    return [...this.sandboxMessages.values()].filter((item) => item.accountId === accountId);
  }

  saveSandboxMessage(record: SandboxMessage): void {
    this.sandboxMessages.set(record.id, record);
    this.persist('sandbox_messages', record.id, record);
  }

  listSandboxDrafts(accountId: string): SandboxDraft[] {
    return [...this.sandboxDrafts.values()].filter((item) => item.accountId === accountId);
  }

  getSandboxDraft(accountId: string, draftId: string): SandboxDraft | undefined {
    const draft = this.sandboxDrafts.get(draftId);
    return draft && draft.accountId === accountId ? draft : undefined;
  }

  saveSandboxDraft(record: SandboxDraft): void {
    this.sandboxDrafts.set(record.id, record);
    this.persist('sandbox_drafts', record.id, record);
  }

  listSandboxVerifications(accountId: string): SandboxVerification[] {
    return [...this.sandboxVerifications.values()].filter((item) => item.accountId === accountId);
  }

  saveSandboxVerification(record: SandboxVerification): void {
    this.sandboxVerifications.set(record.id, record);
    this.persist('sandbox_verifications', record.id, record);
  }

  listSandboxEvents(accountId: string): SandboxEvent[] {
    return [...this.sandboxEvents.values()].filter((item) => item.accountId === accountId);
  }

  saveSandboxEvent(record: SandboxEvent): void {
    this.sandboxEvents.set(record.id, record);
    this.persist('sandbox_events', record.id, record);
  }

  listSandboxMemories(accountId: string): SandboxMemory[] {
    return [...this.sandboxMemories.values()].filter((item) => item.accountId === accountId);
  }

  saveSandboxMemory(record: SandboxMemory): void {
    this.sandboxMemories.set(record.id, record);
    this.persist('sandbox_memories', record.id, record);
  }

  getSandboxQuota(accountId: string, day: string): SandboxQuota {
    return this.sandboxQuota.get(`${accountId}:${day}`) ?? { accountId, day, used: 0 };
  }

  saveSandboxQuota(record: SandboxQuota): void {
    this.sandboxQuota.set(`${record.accountId}:${record.day}`, record);
    this.persist('sandbox_quota', `${record.accountId}:${record.day}`, record);
  }

  clearSandboxData(accountId: string): void {
    const drop = <T extends { id: string }>(map: Map<string, T>, table: ConsoleTable, matches: (item: T) => boolean) => {
      for (const [key, item] of map) {
        if (!matches(item)) continue;
        map.delete(key);
        this.persistDelete(table, key);
      }
    };
    drop(this.sandboxMessages, 'sandbox_messages', (item) => item.accountId === accountId);
    drop(this.sandboxDrafts, 'sandbox_drafts', (item) => item.accountId === accountId);
    drop(this.sandboxVerifications, 'sandbox_verifications', (item) => item.accountId === accountId);
    drop(this.sandboxEvents, 'sandbox_events', (item) => item.accountId === accountId);
    drop(this.sandboxMemories, 'sandbox_memories', (item) => item.accountId === accountId);
  }

  // ---------- 媒体 ----------

  getMedia(id: string): ConsoleMediaRecord | undefined {
    return this.media.get(id);
  }

  saveMedia(record: ConsoleMediaRecord): void {
    this.media.set(record.id, record);
    this.persist('media', record.id, record);
  }

  // ---------- 落盘 ----------

  async flush(): Promise<void> {
    await this.chain;
  }

  private persist(table: ConsoleTable, key: string, value: unknown): void {
    this.chain = this.chain
      .then(() => this.backend.put(table, key, value))
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.onPersistError?.(wrapped);
      });
  }

  private persistDelete(table: ConsoleTable, key: string): void {
    this.chain = this.chain
      .then(async () => {
        await this.backend.delete(table, key);
      })
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.onPersistError?.(wrapped);
      });
  }
}
