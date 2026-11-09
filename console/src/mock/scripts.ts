import scriptsFixture from './fixtures/scripts.json';
import { apiRequest, isMockMode } from './http.ts';
import { readStore, toQuery, writeStore } from './storage.ts';
import type { ScriptTemplate } from '../types.ts';

const STORE_KEY = 'zhiban.console.scripts';

function load(): ScriptTemplate[] {
  return readStore<ScriptTemplate[]>(STORE_KEY, scriptsFixture as unknown as ScriptTemplate[]);
}

/** GET /scripts：B 档示例数据 */
export async function listScripts(
  params: { category?: string; q?: string } = {},
): Promise<{ items: ScriptTemplate[]; total: number; sample: boolean }> {
  if (!isMockMode) return apiRequest(`/scripts${toQuery(params)}`);

  let items = load();
  if (params.category) items = items.filter((item) => item.category === params.category);
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

export function resetScriptsState(): void {
  writeStore(STORE_KEY, scriptsFixture);
}
