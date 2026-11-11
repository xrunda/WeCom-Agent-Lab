import scriptsFixture from './fixtures/scripts.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';
import { mockId, readStore, toQuery, writeStore } from './storage.ts';
import type { ScriptTemplate } from '../types.ts';

const STORE_KEY = 'zhiban.console.scripts';

export interface ScriptListParams {
  category?: string;
  q?: string;
  enabled?: boolean;
}

export interface ScriptInput {
  category: string;
  title: string;
  content: string;
  tags?: string[];
  enabled?: boolean;
}

export type ScriptPatch = Partial<ScriptInput>;

export const SCRIPT_LIMITS = {
  title: 60,
  content: 2000,
  category: 30,
  tags: 5,
  tag: 10,
} as const;

function load(): ScriptTemplate[] {
  return readStore<ScriptTemplate[]>(STORE_KEY, scriptsFixture as unknown as ScriptTemplate[]);
}

function save(items: ScriptTemplate[]): void {
  writeStore(STORE_KEY, items);
}

function validate(input: ScriptInput): void {
  if (!input.category?.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写分类', 422);
  }
  if (input.category.trim().length > SCRIPT_LIMITS.category) {
    throw new ApiError('VALIDATION_FAILED', `分类不能超过 ${SCRIPT_LIMITS.category} 字`, 422);
  }
  if (!input.title?.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写话术标题', 422);
  }
  if (input.title.trim().length > SCRIPT_LIMITS.title) {
    throw new ApiError('VALIDATION_FAILED', `标题不能超过 ${SCRIPT_LIMITS.title} 字`, 422);
  }
  if (!input.content?.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写话术内容', 422);
  }
  if (input.content.trim().length > SCRIPT_LIMITS.content) {
    throw new ApiError('VALIDATION_FAILED', `内容不能超过 ${SCRIPT_LIMITS.content} 字`, 422);
  }
  if (input.tags && input.tags.length > SCRIPT_LIMITS.tags) {
    throw new ApiError('VALIDATION_FAILED', `标签最多 ${SCRIPT_LIMITS.tags} 个`, 422);
  }
  for (const tag of input.tags ?? []) {
    if (!tag.trim() || tag.trim().length > SCRIPT_LIMITS.tag) {
      throw new ApiError('VALIDATION_FAILED', `标签长度需为 1–${SCRIPT_LIMITS.tag} 字`, 422);
    }
  }
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}

/** GET /scripts */
export async function listScripts(
  params: ScriptListParams = {},
): Promise<{ items: ScriptTemplate[]; total: number; sample: boolean }> {
  if (!isMockMode) {
    return apiRequest(
      `/scripts${toQuery({
        category: params.category,
        q: params.q,
        enabled: params.enabled,
      })}`,
    );
  }

  let items = load();
  if (params.category) items = items.filter((item) => item.category === params.category);
  if (params.enabled !== undefined) items = items.filter((item) => item.enabled === params.enabled);
  if (params.q?.trim()) {
    const keyword = params.q.trim().toLowerCase();
    items = items.filter(
      (item) =>
        item.title.toLowerCase().includes(keyword) ||
        item.content.toLowerCase().includes(keyword) ||
        item.tags.some((tag) => tag.toLowerCase().includes(keyword)),
    );
  }
  return { items, total: items.length, sample: true };
}

/** POST /scripts */
export async function createScript(input: ScriptInput): Promise<ScriptTemplate> {
  if (!isMockMode) {
    return apiRequest('/scripts', { method: 'POST', body: JSON.stringify(input) });
  }

  validate(input);
  const tenantId = load()[0]?.tenantId ?? 'ten_demo';
  const entry: ScriptTemplate = {
    id: mockId('scr'),
    tenantId,
    category: input.category.trim(),
    title: input.title.trim(),
    content: input.content.trim(),
    tags: cleanTags(input.tags),
    enabled: input.enabled ?? true,
    sample: true,
  };
  save([entry, ...load()]);
  return entry;
}

/** PATCH /scripts/{id} */
export async function updateScript(id: string, patch: ScriptPatch): Promise<ScriptTemplate> {
  if (!isMockMode) {
    return apiRequest(`/scripts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  const items = load();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new ApiError('NOT_FOUND', '话术不存在', 404);
  validate({ ...items[index], ...patch });
  const next: ScriptTemplate = {
    ...items[index],
    ...patch,
    category: patch.category?.trim() ?? items[index].category,
    title: patch.title?.trim() ?? items[index].title,
    content: patch.content?.trim() ?? items[index].content,
    tags: patch.tags === undefined ? items[index].tags : cleanTags(patch.tags),
  };
  items[index] = next;
  save(items);
  return next;
}

/** DELETE /scripts/{id}（软删除） */
export async function deleteScript(id: string): Promise<void> {
  if (!isMockMode) {
    await apiRequest<void>(`/scripts/${id}`, { method: 'DELETE' });
    return;
  }

  const items = load();
  if (!items.some((item) => item.id === id)) {
    throw new ApiError('NOT_FOUND', '话术不存在', 404);
  }
  save(items.filter((item) => item.id !== id));
}

export function resetScriptsState(): void {
  writeStore(STORE_KEY, scriptsFixture);
}
