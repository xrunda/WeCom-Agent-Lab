/**
 * #35 长期记忆：抽取结果、可查可改可删、每轮注入。
 *
 * 设计约定：
 * - 只存「患者/家属明确说过的事实」，不存推断；家属的事 `subject=family`。
 * - 同步读内存镜像，写入异步串行落盘（与 patient-store 一致）。
 * - 删除是软删除；Agent 下一轮不再引用，历史草稿里的 id 保留。
 * - 所有变更写审计，审计里只记 id 与动作，不记正文。
 */
import { idFactory } from './ids.ts';
import type { IdFactory } from './ids.ts';
import type { AuditEvent } from '../c2/types.ts';

export const MEMORY_CATEGORIES = [
  'dietary_taboo',
  'routine',
  'goal',
  'body',
  'family',
  'preference',
  'other',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABEL: Record<MemoryCategory, string> = {
  dietary_taboo: '饮食禁忌/过敏',
  routine: '作息',
  goal: '健康目标',
  body: '身体状况',
  family: '家庭情况',
  preference: '偏好',
  other: '其他',
};

export const MEMORY_SUBJECTS = ['self', 'family', 'unknown'] as const;

export type MemorySubject = (typeof MEMORY_SUBJECTS)[number];

export const MEMORY_SUBJECT_LABEL: Record<MemorySubject, string> = {
  self: '本人',
  family: '家属',
  unknown: '未知',
};

export type MemoryCreatedBy = 'agent' | 'staff';

export interface MemoryRecord {
  id: string;
  tenantId: string;
  patientId: string;
  category: MemoryCategory;
  content: string;
  subject: MemorySubject;
  sourceMsgId?: string;
  sourceText?: string;
  createdBy: MemoryCreatedBy;
  createdById?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  deletedBy?: string;
  sandbox: boolean;
}

export interface MemoryWriteInput {
  patientId: string;
  category: MemoryCategory;
  content: string;
  subject: MemorySubject;
  sourceMsgId?: string;
  sourceText?: string;
  createdBy: MemoryCreatedBy;
  createdById?: string;
}

export interface MemoryUpdateInput {
  category?: MemoryCategory;
  content?: string;
  subject?: MemorySubject;
}

export interface MemoryQuery {
  category?: MemoryCategory;
  includeDeleted?: boolean;
}

export interface MemoryBackend {
  load(): MemoryRecord[];
  put(record: MemoryRecord): Promise<void>;
}

export interface MemoryServiceOptions {
  tenantId: string;
  backend: MemoryBackend;
  /** 每轮注入上限，默认 30 条（docs/P1-api.md 的 memoryInjectLimit） */
  injectLimit?: number;
  sandbox?: boolean;
  now?: () => number;
  newId?: IdFactory;
  onPersistError?: (error: Error) => void;
  onAudit?: (event: AuditEvent) => void;
  emit?: (type: string, data: unknown) => void;
}

export type MemoryErrorCode =
  | 'EMPTY_CONTENT'
  | 'CONTENT_TOO_LONG'
  | 'INVALID_CATEGORY'
  | 'INVALID_SUBJECT'
  | 'NOT_FOUND'
  | 'WRONG_PATIENT';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export const MEMORY_CONTENT_MAX = 200;
export const MEMORY_SOURCE_TEXT_MAX = 100;

function assertCategory(value: unknown): MemoryCategory {
  if (!MEMORY_CATEGORIES.includes(value as MemoryCategory)) {
    throw new MemoryError('INVALID_CATEGORY', `category 必须是 ${MEMORY_CATEGORIES.join('/')}`);
  }
  return value as MemoryCategory;
}

function assertSubject(value: unknown): MemorySubject {
  if (!MEMORY_SUBJECTS.includes(value as MemorySubject)) {
    throw new MemoryError('INVALID_SUBJECT', `subject 必须是 ${MEMORY_SUBJECTS.join('/')}`);
  }
  return value as MemorySubject;
}

function assertContent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryError('EMPTY_CONTENT', 'content 不能为空');
  }
  const content = value.trim();
  if (content.length > MEMORY_CONTENT_MAX) {
    throw new MemoryError('CONTENT_TOO_LONG', `content 不能超过 ${MEMORY_CONTENT_MAX} 字`);
  }
  return content;
}

function optionalSourceText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  return text.length > MEMORY_SOURCE_TEXT_MAX ? text.slice(0, MEMORY_SOURCE_TEXT_MAX) : text;
}

function byCategoryThenCreated(a: MemoryRecord, b: MemoryRecord): number {
  const order = MEMORY_CATEGORIES.indexOf(a.category) - MEMORY_CATEGORIES.indexOf(b.category);
  return order !== 0 ? order : a.createdAt - b.createdAt;
}

export class MemoryService {
  private readonly tenantId: string;
  private readonly backend: MemoryBackend;
  private readonly injectLimit: number;
  private readonly sandbox: boolean;
  private readonly now: () => number;
  private readonly makeId: IdFactory;
  private readonly onPersistError?: (error: Error) => void;
  private readonly onAudit?: (event: AuditEvent) => void;
  private readonly emit: (type: string, data: unknown) => void;

  private readonly records = new Map<string, MemoryRecord>();
  private readonly auditLog: AuditEvent[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(options: MemoryServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.injectLimit = options.injectLimit ?? 30;
    this.sandbox = options.sandbox ?? false;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.newId ?? idFactory(this.now);
    this.onPersistError = options.onPersistError;
    this.onAudit = options.onAudit;
    this.emit = options.emit ?? (() => undefined);
    for (const record of options.backend.load()) {
      this.records.set(record.id, record);
    }
  }

  write(input: MemoryWriteInput): MemoryRecord {
    const category = assertCategory(input.category);
    const subject = assertSubject(input.subject);
    const content = assertContent(input.content);
    const at = this.now();
    const record: MemoryRecord = {
      id: this.makeId('mem'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      category,
      content,
      subject,
      sourceMsgId: input.sourceMsgId,
      sourceText: optionalSourceText(input.sourceText),
      createdBy: input.createdBy,
      createdById: input.createdById,
      createdAt: at,
      updatedAt: at,
      sandbox: this.sandbox,
    };
    this.records.set(record.id, record);
    this.persist(record);
    this.audit(record.createdBy === 'staff' ? 'staff' : 'agent', 'memory.write', record.id, 'ok');
    this.changed('memory.created', record);
    return record;
  }

  /** 同一患者同一类别的同一句话不重复记，更新来源而不是新增 */
  upsertFact(input: MemoryWriteInput): MemoryRecord {
    const content = assertContent(input.content);
    const existing = this.list(input.patientId).find(
      (record) => record.category === input.category && record.content === content,
    );
    if (!existing) return this.write(input);
    const at = this.now();
    const updated: MemoryRecord = {
      ...existing,
      subject: input.subject,
      sourceMsgId: input.sourceMsgId ?? existing.sourceMsgId,
      sourceText: optionalSourceText(input.sourceText) ?? existing.sourceText,
      updatedAt: at,
    };
    this.records.set(updated.id, updated);
    this.persist(updated);
    this.audit('agent', 'memory.update', updated.id, 'ok');
    this.changed('memory.updated', updated);
    return updated;
  }

  update(id: string, patch: MemoryUpdateInput, actor: 'agent' | 'staff' = 'agent', actorId?: string): MemoryRecord {
    const existing = this.get(id);
    if (!existing) throw new MemoryError('NOT_FOUND', `记忆 ${id} 不存在`);
    const updated: MemoryRecord = {
      ...existing,
      category: patch.category === undefined ? existing.category : assertCategory(patch.category),
      content: patch.content === undefined ? existing.content : assertContent(patch.content),
      subject: patch.subject === undefined ? existing.subject : assertSubject(patch.subject),
      updatedAt: this.now(),
    };
    this.records.set(id, updated);
    this.persist(updated);
    this.audit(actor, 'memory.update', id, 'ok', actorId);
    this.changed('memory.updated', updated);
    return updated;
  }

  remove(id: string, actor: 'agent' | 'staff' = 'staff', actorId?: string): MemoryRecord {
    const existing = this.get(id);
    if (!existing) throw new MemoryError('NOT_FOUND', `记忆 ${id} 不存在`);
    if (existing.deletedAt !== undefined) return existing;
    const at = this.now();
    const deleted: MemoryRecord = {
      ...existing,
      deletedAt: at,
      updatedAt: at,
      deletedBy: actorId,
    };
    this.records.set(id, deleted);
    this.persist(deleted);
    this.audit(actor, 'memory.delete', id, 'ok', actorId);
    this.changed('memory.deleted', deleted);
    return deleted;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  list(patientId: string, query: MemoryQuery = {}): MemoryRecord[] {
    return [...this.records.values()]
      .filter((record) => record.patientId === patientId)
      .filter((record) => (query.includeDeleted ? true : record.deletedAt === undefined))
      .filter((record) => (query.category ? record.category === query.category : true))
      .sort(byCategoryThenCreated);
  }

  /** 每轮注入：只含有效记忆，按分类分组，带 id 便于 citedMemoryIds */
  render(patientId: string): string[] {
    const active = this.list(patientId).slice(0, this.injectLimit);
    if (active.length === 0) return [];
    const lines = ['【患者长期记忆（引用时把方括号里的 id 填进 citedMemoryIds）】'];
    let current: MemoryCategory | undefined;
    for (const record of active) {
      if (record.category !== current) {
        current = record.category;
        lines.push(`- ${MEMORY_CATEGORY_LABEL[current]}`);
      }
      lines.push(
        `  - [${record.id}] ${record.content}（${MEMORY_SUBJECT_LABEL[record.subject]}）`,
      );
    }
    return lines;
  }

  audits(): AuditEvent[] {
    return [...this.auditLog];
  }

  count(patientId: string): number {
    return this.list(patientId).length;
  }

  /** 等待所有落盘完成；插件卸载时调用 */
  async flush(): Promise<void> {
    await this.chain;
  }

  private audit(
    actor: string,
    action: string,
    target: string,
    result: string,
    errorCode?: string,
  ): void {
    const event: AuditEvent = { at: this.now(), actor, action, target, result };
    if (errorCode) event.errorCode = errorCode;
    this.auditLog.push(event);
    this.onAudit?.(event);
  }

  /** 只广播定位字段，不带正文（正文只在业务实体与鉴权接口里） */
  private changed(type: 'memory.created' | 'memory.updated' | 'memory.deleted', record: MemoryRecord): void {
    this.emit(type, {
      memoryId: record.id,
      patientId: record.patientId,
      category: record.category,
      subject: record.subject,
    });
  }

  private persist(record: MemoryRecord): void {
    this.chain = this.chain
      .then(() => this.backend.put(record))
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.onPersistError?.(wrapped);
      });
  }
}
