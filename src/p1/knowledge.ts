/**
 * #38 知识库：条目 CRUD、skill 资源生成、引用命中统计。
 *
 * 设计约定：
 * - 知识条目按分类生成 Markdown skill 资源，只包含启用且未删除的条目；
 *   保存后立即重写文件，下一轮会话由文件系统 skill provider 重新读取。
 * - Agent 在草稿里引用条目时把 id 填进 citedKnowledgeIds；插件监听
 *   reply_draft 的成功结果累加 hits。
 * - 删除是软删除；停用与删除都不会再出现在 skill 资源里。
 * - 日志、审计、事件都不带条目正文。
 */
import type { AuditEvent } from '../c2/types.ts';

export interface KnowledgeRecord {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  content: string;
  enabled: boolean;
  hits: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface KnowledgeCreateInput {
  category: string;
  title: string;
  content: string;
  enabled?: boolean;
}

export interface KnowledgeUpdateInput {
  category?: string;
  title?: string;
  content?: string;
  enabled?: boolean;
}

export interface KnowledgeQuery {
  category?: string;
  enabled?: boolean;
  q?: string;
  includeDeleted?: boolean;
}

export interface KnowledgeBackend {
  load(): KnowledgeRecord[];
  put(record: KnowledgeRecord): Promise<void>;
}

export interface KnowledgeServiceOptions {
  tenantId: string;
  backend: KnowledgeBackend;
  now?: () => number;
  newId?: (prefix: string) => string;
  onPersistError?: (error: Error) => void;
  onAudit?: (event: AuditEvent) => void;
  emit?: (type: string, data: unknown) => void;
}

export const KNOWLEDGE_CATEGORY_MAX = 30;
export const KNOWLEDGE_TITLE_MAX = 60;
export const KNOWLEDGE_CONTENT_MAX = 2000;

export type KnowledgeErrorCode =
  | 'EMPTY_CATEGORY'
  | 'CATEGORY_TOO_LONG'
  | 'EMPTY_TITLE'
  | 'TITLE_TOO_LONG'
  | 'EMPTY_CONTENT'
  | 'CONTENT_TOO_LONG'
  | 'NOT_FOUND';

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;

  constructor(code: KnowledgeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

function defaultId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function assertText(
  value: unknown,
  field: string,
  max: number,
  emptyCode: KnowledgeErrorCode,
  longCode: KnowledgeErrorCode,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KnowledgeError(emptyCode, `${field} 不能为空`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new KnowledgeError(longCode, `${field} 不能超过 ${max} 字`);
  }
  return text;
}

export interface KnowledgeSeedEntry {
  id: string;
  category: string;
  title: string;
  content: string;
}

export class KnowledgeService {
  private readonly tenantId: string;
  private readonly backend: KnowledgeBackend;
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly onPersistError?: (error: Error) => void;
  private readonly onAudit?: (event: AuditEvent) => void;
  private readonly emit: (type: string, data: unknown) => void;

  private readonly records = new Map<string, KnowledgeRecord>();
  private readonly auditLog: AuditEvent[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(options: KnowledgeServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.newId ?? defaultId;
    this.onPersistError = options.onPersistError;
    this.onAudit = options.onAudit;
    this.emit = options.emit ?? (() => undefined);
    for (const record of options.backend.load()) this.records.set(record.id, record);
  }

  create(input: KnowledgeCreateInput, actor = 'staff'): KnowledgeRecord {
    const category = assertText(input.category, 'category', KNOWLEDGE_CATEGORY_MAX, 'EMPTY_CATEGORY', 'CATEGORY_TOO_LONG');
    const title = assertText(input.title, 'title', KNOWLEDGE_TITLE_MAX, 'EMPTY_TITLE', 'TITLE_TOO_LONG');
    const content = assertText(input.content, 'content', KNOWLEDGE_CONTENT_MAX, 'EMPTY_CONTENT', 'CONTENT_TOO_LONG');
    const at = this.now();
    const record: KnowledgeRecord = {
      id: this.makeId('knw'),
      tenantId: this.tenantId,
      category,
      title,
      content,
      enabled: input.enabled ?? true,
      hits: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(record.id, record);
    this.persist(record);
    this.audit(actor, 'knowledge.create', record.id, 'ok');
    this.emit('knowledge.created', { knowledgeId: record.id, category, enabled: record.enabled });
    return record;
  }

  update(id: string, patch: KnowledgeUpdateInput, actor = 'staff'): KnowledgeRecord {
    const existing = this.require(id);
    const updated: KnowledgeRecord = {
      ...existing,
      category:
        patch.category === undefined
          ? existing.category
          : assertText(patch.category, 'category', KNOWLEDGE_CATEGORY_MAX, 'EMPTY_CATEGORY', 'CATEGORY_TOO_LONG'),
      title:
        patch.title === undefined
          ? existing.title
          : assertText(patch.title, 'title', KNOWLEDGE_TITLE_MAX, 'EMPTY_TITLE', 'TITLE_TOO_LONG'),
      content:
        patch.content === undefined
          ? existing.content
          : assertText(patch.content, 'content', KNOWLEDGE_CONTENT_MAX, 'EMPTY_CONTENT', 'CONTENT_TOO_LONG'),
      enabled: patch.enabled === undefined ? existing.enabled : Boolean(patch.enabled),
      updatedAt: this.now(),
    };
    this.records.set(id, updated);
    this.persist(updated);
    this.audit(actor, 'knowledge.update', id, 'ok');
    this.emit('knowledge.updated', {
      knowledgeId: id,
      category: updated.category,
      enabled: updated.enabled,
    });
    return updated;
  }

  remove(id: string, actor = 'staff'): KnowledgeRecord {
    const existing = this.require(id);
    if (existing.deletedAt !== undefined) return existing;
    const at = this.now();
    const deleted: KnowledgeRecord = { ...existing, deletedAt: at, enabled: false, updatedAt: at };
    this.records.set(id, deleted);
    this.persist(deleted);
    this.audit(actor, 'knowledge.delete', id, 'ok');
    this.emit('knowledge.deleted', { knowledgeId: id, category: deleted.category });
    return deleted;
  }

  get(id: string): KnowledgeRecord | undefined {
    return this.records.get(id);
  }

  /**
   * 幂等写入示例条目：id 已存在或同分类同标题已存在时跳过。
   * 示例数据用固定 id，重启 / 多环境部署不会重复。
   */
  seed(entries: readonly KnowledgeSeedEntry[]): number {
    let added = 0;
    for (const entry of entries) {
      if (this.records.has(entry.id)) continue;
      const duplicate = [...this.records.values()].some(
        (record) =>
          record.deletedAt === undefined &&
          record.category === entry.category &&
          record.title === entry.title,
      );
      if (duplicate) continue;
      const at = this.now();
      const record: KnowledgeRecord = {
        id: entry.id,
        tenantId: this.tenantId,
        category: entry.category,
        title: entry.title,
        content: entry.content,
        enabled: true,
        hits: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.records.set(record.id, record);
      this.persist(record);
      this.audit('system', 'knowledge.seed', record.id, 'ok');
      added += 1;
    }
    if (added > 0) {
      this.emit('knowledge.seeded', { count: added });
    }
    return added;
  }

  list(query: KnowledgeQuery = {}): KnowledgeRecord[] {
    const q = query.q?.trim().toLowerCase();
    return [...this.records.values()]
      .filter((record) => (query.includeDeleted ? true : record.deletedAt === undefined))
      .filter((record) => (query.category ? record.category === query.category : true))
      .filter((record) => (query.enabled === undefined ? true : record.enabled === query.enabled))
      .filter((record) =>
        q ? record.title.toLowerCase().includes(q) || record.content.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => {
        const byCategory = a.category.localeCompare(b.category, 'zh-CN');
        return byCategory !== 0 ? byCategory : a.title.localeCompare(b.title, 'zh-CN');
      });
  }

  categories(): string[] {
    return [...new Set(this.list().map((record) => record.category))].sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
  }

  /** 草稿引用后累加命中；未知 / 停用 / 已删除 id 直接忽略 */
  recordCitations(ids: string[]): number {
    let changed = 0;
    for (const id of new Set(ids)) {
      const record = this.records.get(id);
      if (!record || record.deletedAt !== undefined || !record.enabled) continue;
      const updated: KnowledgeRecord = {
        ...record,
        hits: record.hits + 1,
        updatedAt: this.now(),
      };
      this.records.set(id, updated);
      this.persist(updated);
      this.audit('system', 'knowledge.hit', id, 'ok');
      this.emit('knowledge.hit', {
        knowledgeId: id,
        category: updated.category,
        hits: updated.hits,
      });
      changed += 1;
    }
    return changed;
  }

  count(): number {
    return this.list().length;
  }

  audits(): AuditEvent[] {
    return [...this.auditLog];
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private require(id: string): KnowledgeRecord {
    const record = this.records.get(id);
    if (!record) throw new KnowledgeError('NOT_FOUND', `知识条目 ${id} 不存在`);
    return record;
  }

  private audit(actor: string, action: string, target: string, result: string): void {
    const event: AuditEvent = { at: this.now(), actor, action, target, result };
    this.auditLog.push(event);
    this.onAudit?.(event);
  }

  private persist(record: KnowledgeRecord): void {
    this.chain = this.chain
      .then(() => this.backend.put(record))
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.onPersistError?.(wrapped);
      });
  }
}

// ---------- skill 资源 ----------

export interface SkillFile {
  /** 文件名，如 zhiban-knowledge-1a2b3c4d.md */
  name: string;
  category: string;
  content: string;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function frontmatterSafe(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 按分类生成 skill 文件；只包含启用且未删除的条目。
 * 分类名只出现在标题与描述里，文件名用稳定哈希，避免中文 / 标点导致非法 skill 名。
 */
export function buildSkillFiles(records: KnowledgeRecord[]): SkillFile[] {
  const usable = records.filter((record) => record.enabled && record.deletedAt === undefined);
  const byCategory = new Map<string, KnowledgeRecord[]>();
  for (const record of usable) {
    const list = byCategory.get(record.category) ?? [];
    list.push(record);
    byCategory.set(record.category, list);
  }

  const files: SkillFile[] = [];
  const usedNames = new Set<string>();
  for (const [category, entries] of byCategory) {
    let hash = fnv1a(category);
    let attempt = 0;
    while (usedNames.has(hash)) {
      attempt += 1;
      hash = fnv1a(`${category}#${attempt}`);
    }
    usedNames.add(hash);

    entries.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    const name = `zhiban-knowledge-${hash}`;
    const safeCategory = frontmatterSafe(category);
    const lines = [
      '---',
      `name: ${name}`,
      `description: ${frontmatterSafe(`机构知识库：${category}（${entries.length} 条，引用时把 id 填进 citedKnowledgeIds）`)}`,
      '---',
      '',
      `# 机构知识库 · ${safeCategory}`,
      '',
      '回答患者时，如果用到下面任一条，请把方括号里的 id 填进 reply_draft 的 citedKnowledgeIds。',
      '只引用与当前问题直接相关的条目；没有列出的内容不要编造。',
      '',
    ];
    for (const entry of entries) {
      lines.push(`## [${entry.id}] ${frontmatterSafe(entry.title)}`, '', entry.content, '');
    }
    files.push({ name: `${name}.md`, category, content: lines.join('\n').trimEnd() + '\n' });
  }
  return files.sort((a, b) => a.category.localeCompare(b.category, 'zh-CN'));
}

/** 保存后重写 skill 资源：写新文件 → 删除旧清单里不再生成的文件 → 写清单 */
export interface SkillFileStore {
  list(): Promise<string[]>;
  write(name: string, content: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export async function syncSkillFiles(store: SkillFileStore, files: SkillFile[]): Promise<void> {
  const next = new Set(files.map((file) => file.name));
  for (const file of files) await store.write(file.name, file.content);
  for (const name of await store.list()) {
    if (name.startsWith('zhiban-knowledge-') && !next.has(name)) await store.remove(name);
  }
}
