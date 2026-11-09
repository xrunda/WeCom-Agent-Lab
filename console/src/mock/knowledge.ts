import knowledgeFixture from './fixtures/knowledge.json';
import tenantFixture from './fixtures/tenant.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';
import { mockId, readStore, toQuery, writeStore } from './storage.ts';
import type { KnowledgeEntry, Tenant } from '../types.ts';

const STORE_KEY = 'zhiban.console.knowledge';
const TENANT_ID = (tenantFixture as unknown as Tenant).id;

export interface KnowledgeListParams {
  category?: string;
  enabled?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface KnowledgeCategory {
  category: string;
  count: number;
}

export interface KnowledgeInput {
  category: string;
  title: string;
  content: string;
  enabled?: boolean;
}

export interface KnowledgePatch {
  category?: string;
  title?: string;
  content?: string;
  enabled?: boolean;
}

function load(): KnowledgeEntry[] {
  return readStore<KnowledgeEntry[]>(STORE_KEY, knowledgeFixture as unknown as KnowledgeEntry[]);
}

function save(items: KnowledgeEntry[]): void {
  writeStore(STORE_KEY, items);
}

function active(items: KnowledgeEntry[]): KnowledgeEntry[] {
  return items.filter((item) => item.deletedAt === null);
}

function validate(input: KnowledgeInput): void {
  if (!input.category.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请选择或填写分类', 422);
  }
  if (!input.title.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写知识标题', 422);
  }
  if (!input.content.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写知识内容', 422);
  }
}

/** GET /knowledge */
export async function listKnowledge(
  params: KnowledgeListParams = {},
): Promise<{ items: KnowledgeEntry[]; total: number }> {
  if (!isMockMode) {
    return apiRequest(
      `/knowledge${toQuery({
        category: params.category,
        enabled: params.enabled,
        q: params.q,
        page: params.page,
        pageSize: params.pageSize,
      })}`,
    );
  }

  let items = active(load());
  if (params.category) items = items.filter((item) => item.category === params.category);
  if (params.enabled !== undefined) items = items.filter((item) => item.enabled === params.enabled);
  if (params.q?.trim()) {
    const keyword = params.q.trim().toLowerCase();
    items = items.filter(
      (item) =>
        item.title.toLowerCase().includes(keyword) ||
        item.content.toLowerCase().includes(keyword),
    );
  }
  items = [...items].sort(
    (a, b) => a.category.localeCompare(b.category, 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'),
  );

  const total = items.length;
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total };
}

/** GET /knowledge/categories */
export async function listKnowledgeCategories(): Promise<{ items: KnowledgeCategory[] }> {
  if (!isMockMode) return apiRequest('/knowledge/categories');

  const counts = new Map<string, number>();
  active(load()).forEach((item) => {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  });
  return {
    items: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.category.localeCompare(b.category, 'zh-CN')),
  };
}

/** POST /knowledge */
export async function createKnowledge(input: KnowledgeInput): Promise<KnowledgeEntry> {
  if (!isMockMode) {
    return apiRequest('/knowledge', { method: 'POST', body: JSON.stringify(input) });
  }

  validate(input);
  const now = Date.now();
  const entry: KnowledgeEntry = {
    id: mockId('knw'),
    tenantId: TENANT_ID,
    category: input.category.trim(),
    title: input.title.trim(),
    content: input.content.trim(),
    enabled: input.enabled ?? true,
    hits: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  save([entry, ...load()]);
  return entry;
}

/** PATCH /knowledge/{id} */
export async function updateKnowledge(id: string, patch: KnowledgePatch): Promise<KnowledgeEntry> {
  if (!isMockMode) {
    return apiRequest(`/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  const items = load();
  const index = items.findIndex((item) => item.id === id && item.deletedAt === null);
  if (index < 0) throw new ApiError('NOT_FOUND', '知识条目不存在或已删除', 404);

  const next: KnowledgeEntry = {
    ...items[index],
    ...patch,
    category: patch.category?.trim() ?? items[index].category,
    title: patch.title?.trim() ?? items[index].title,
    content: patch.content?.trim() ?? items[index].content,
    updatedAt: Date.now(),
  };
  if (patch.title !== undefined && !next.title) {
    throw new ApiError('VALIDATION_FAILED', '请填写知识标题', 422);
  }
  if (patch.content !== undefined && !next.content) {
    throw new ApiError('VALIDATION_FAILED', '请填写知识内容', 422);
  }
  items[index] = next;
  save(items);
  return next;
}

/** DELETE /knowledge/{id}（软删除） */
export async function deleteKnowledge(id: string): Promise<void> {
  if (!isMockMode) {
    await apiRequest<void>(`/knowledge/${id}`, { method: 'DELETE' });
    return;
  }

  const items = load();
  const index = items.findIndex((item) => item.id === id && item.deletedAt === null);
  if (index < 0) throw new ApiError('NOT_FOUND', '知识条目不存在或已删除', 404);
  items[index] = { ...items[index], deletedAt: Date.now(), updatedAt: Date.now() };
  save(items);
}

export function resetKnowledgeState(): void {
  writeStore(STORE_KEY, knowledgeFixture);
}
