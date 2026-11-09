import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSkillFiles,
  KnowledgeError,
  KnowledgeService,
  syncSkillFiles,
} from '../src/p1/knowledge.ts';
import type {
  KnowledgeBackend,
  KnowledgeRecord,
  SkillFileStore,
} from '../src/p1/knowledge.ts';
import { EXAMPLE_KNOWLEDGE } from '../src/p1/knowledge-seed.ts';
import { parseKnowledgeConfig } from '../plugins/zhiban-knowledge/config.ts';
import { apply as applyKnowledgePlugin } from '../plugins/zhiban-knowledge/index.ts';

class MemoryKnowledgeBackend implements KnowledgeBackend {
  readonly records = new Map<string, KnowledgeRecord>();
  failWrites = false;

  load(): KnowledgeRecord[] {
    return [...this.records.values()];
  }

  async put(record: KnowledgeRecord): Promise<void> {
    if (this.failWrites) throw new Error('WRITE_FAILED');
    this.records.set(record.id, record);
  }
}

function harness() {
  const backend = new MemoryKnowledgeBackend();
  const events: Array<{ type: string; data: unknown }> = [];
  let seq = 0;
  const service = new KnowledgeService({
    tenantId: 'tn_test',
    backend,
    now: () => 1_700_000_000_000,
    newId: (prefix) => `${prefix}_test_${++seq}`,
    emit: (type, data) => events.push({ type, data }),
  });
  return { backend, service, events };
}

test('#38 示例知识 30 条，重复 seed 幂等', async () => {
  const h = harness();
  assert.equal(EXAMPLE_KNOWLEDGE.length, 30);
  assert.equal(h.service.seed(EXAMPLE_KNOWLEDGE), 30);
  assert.equal(h.service.count(), 30);
  assert.equal(h.service.seed(EXAMPLE_KNOWLEDGE), 0);
  assert.equal(h.service.count(), 30);
  const categories = h.service.categories();
  assert.equal(categories.length, 6);
  for (const category of ['饮食建议', '作息与睡眠', '运动与体重', '情绪与压力', '慢病日常', '服务与随访']) {
    assert.ok(categories.includes(category), `缺少分类 ${category}`);
  }
  await h.service.flush();
  assert.equal(h.backend.records.size, 30);
  assert.ok(h.service.audits().some((event) => event.action === 'knowledge.seed'));
});

test('#38 条目校验：分类 / 标题 / 正文长度', () => {
  const h = harness();
  assert.throws(
    () => h.service.create({ category: ' ', title: '标题', content: '内容' }),
    /EMPTY_CATEGORY/,
  );
  assert.throws(
    () => h.service.create({ category: 'x'.repeat(31), title: '标题', content: '内容' }),
    /CATEGORY_TOO_LONG/,
  );
  assert.throws(
    () => h.service.create({ category: '分类', title: '', content: '内容' }),
    /EMPTY_TITLE/,
  );
  assert.throws(
    () => h.service.create({ category: '分类', title: 'x'.repeat(61), content: '内容' }),
    /TITLE_TOO_LONG/,
  );
  assert.throws(
    () => h.service.create({ category: '分类', title: '标题', content: ' ' }),
    /EMPTY_CONTENT/,
  );
  assert.throws(
    () => h.service.create({ category: '分类', title: '标题', content: 'x'.repeat(2001) }),
    /CONTENT_TOO_LONG/,
  );
  assert.throws(() => h.service.update('knw_missing', { title: '新' }), (error: unknown) => {
    return error instanceof KnowledgeError && error.code === 'NOT_FOUND';
  });
});

test('#38 增改删与查询：软删除、停用、搜索', async () => {
  const h = harness();
  h.service.seed(EXAMPLE_KNOWLEDGE);
  const created = h.service.create({ category: '测试分类', title: '测试条目', content: '仅用于测试的虚构内容。' });
  assert.match(created.id, /^knw_/);
  assert.equal(created.hits, 0);
  assert.equal(h.service.list({ q: '虚构' }).length, 1);

  const updated = h.service.update(created.id, { title: '测试条目（改）', enabled: false });
  assert.equal(updated.title, '测试条目（改）');
  assert.equal(updated.enabled, false);
  assert.equal(h.service.list({ enabled: true }).some((item) => item.id === created.id), false);
  assert.equal(h.service.list({ enabled: false }).some((item) => item.id === created.id), true);

  const removed = h.service.remove(created.id);
  assert.ok(removed.deletedAt !== undefined);
  assert.equal(h.service.list().some((item) => item.id === created.id), false);
  assert.equal(h.service.list({ includeDeleted: true }).some((item) => item.id === created.id), true);
  await h.service.flush();
  assert.equal(h.backend.records.get(created.id)?.deletedAt, removed.deletedAt);
});

test('#38 引用命中：只统计启用且未删除的条目', async () => {
  const h = harness();
  const a = h.service.create({ category: '分类A', title: '条目A', content: '内容A' });
  const b = h.service.create({ category: '分类A', title: '条目B', content: '内容B' });
  h.service.update(b.id, { enabled: false });

  const changed = h.service.recordCitations([a.id, a.id, b.id, 'knw_missing']);
  assert.equal(changed, 1);
  assert.equal(h.service.get(a.id)?.hits, 1);
  assert.equal(h.service.get(b.id)?.hits, 0);
  assert.ok(h.service.audits().some((event) => event.action === 'knowledge.hit' && event.target === a.id));
  assert.ok(h.events.some((event) => event.type === 'knowledge.hit'));
});

test('#38 skill 资源：按分类生成，只含启用条目，文件名稳定', () => {
  const h = harness();
  h.service.seed(EXAMPLE_KNOWLEDGE);
  const files = buildSkillFiles(h.service.list());
  assert.equal(files.length, 6);
  assert.ok(files.every((file) => file.name.startsWith('zhiban-knowledge-')));
  assert.ok(files.every((file) => file.name.endsWith('.md')));
  assert.equal(new Set(files.map((file) => file.name)).size, files.length);

  const diet = files.find((file) => file.category === '饮食建议')!;
  assert.match(diet.content, /^---\nname: zhiban-knowledge-/);
  assert.match(diet.content, /\ndescription: /);
  assert.match(diet.content, /## \[knw_seed_01\] 晚餐建议在 19 点前完成/);
  assert.match(diet.content, /citedKnowledgeIds/);

  const target = h.service.list().find((item) => item.id === 'knw_seed_01')!;
  h.service.update(target.id, { enabled: false });
  const after = buildSkillFiles(h.service.list());
  const dietAfter = after.find((file) => file.category === '饮食建议')!;
  assert.equal(dietAfter.content.includes('knw_seed_01'), false);

  h.service.remove('knw_seed_07');
  assert.equal(
    buildSkillFiles(h.service.list()).some((file) => file.content.includes('knw_seed_07')),
    false,
  );
});

test('#38 syncSkillFiles：写新文件、删除过期文件、不动非本插件文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-skill-'));
  try {
    const store: SkillFileStore = {
      async list() {
        return (await readdir(dir)).filter((name) => name.endsWith('.md'));
      },
      async write(name, content) {
        await writeFile(join(dir, name), content, 'utf8');
      },
      async remove(name) {
        await rm(join(dir, name), { force: true });
      },
    };
    await writeFile(join(dir, 'custom-skill.md'), 'keep me', 'utf8');
    await writeFile(join(dir, 'zhiban-knowledge-deadbeef.md'), 'stale', 'utf8');

    const h = harness();
    h.service.seed(EXAMPLE_KNOWLEDGE);
    const files = buildSkillFiles(h.service.list());
    await syncSkillFiles(store, files);

    const names = await readdir(dir);
    assert.ok(names.includes('custom-skill.md'));
    assert.equal(names.includes('zhiban-knowledge-deadbeef.md'), false);
    for (const file of files) {
      assert.ok(names.includes(file.name));
      assert.equal(await readFile(join(dir, file.name), 'utf8'), file.content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#38 配置：tenantId / skillDir 必填，相对路径按 workspaceRoot 解析', () => {
  assert.throws(() => parseKnowledgeConfig({ skillDir: '/tmp/skills' }), /缺少配置项 tenantId/);
  assert.throws(() => parseKnowledgeConfig({ tenantId: 'tn' }), /缺少配置项 skillDir/);
  assert.throws(() => parseKnowledgeConfig(null), /插件配置必须是对象/);

  const absolute = parseKnowledgeConfig({ tenantId: 'tn', skillDir: '/tmp/skills' });
  assert.equal(absolute.skillDir, '/tmp/skills');
  assert.equal(absolute.seedExamples, true);

  const relative = parseKnowledgeConfig({
    tenantId: 'tn',
    skillDir: 'skills/knowledge',
    workspaceRoot: '/tmp/ws',
    seedExamples: false,
  });
  assert.equal(relative.skillDir, '/tmp/ws/skills/knowledge');
  assert.equal(relative.seedExamples, false);
});

// ---------- 插件装配 ----------

class FakeTable {
  readonly map = new Map<string, unknown>();

  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries();
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

class FakeDomain {
  readonly tables = new Map<string, FakeTable>();
  closed = false;

  table(name: string): FakeTable {
    const table = this.tables.get(name) ?? new FakeTable();
    this.tables.set(name, table);
    return table;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function pluginHarness() {
  const domain = new FakeDomain();
  const provided = new Map<string, unknown>();
  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const effects: Array<Promise<unknown>> = [];

  const ctx = {
    logger: { info: (line: string) => logs.push(line) },
    effect: (fn: () => unknown) => {
      const promise = Promise.resolve().then(fn);
      effects.push(promise);
      return promise;
    },
    emit: (type: string, data: unknown) => events.push({ type, data }),
    provide: (name: string, value: unknown) => provided.set(name, value),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    storageDomain: {
      async open() {
        return domain;
      },
    },
  };

  return { domain, provided, events, logs, listeners, effects, ctx };
}

test('#38 插件装配：seed → 生成 skill 文件 → 引用计数 → 卸载落盘', async () => {
  const h = pluginHarness();
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-knowledge-plugin-'));
  try {
    applyKnowledgePlugin(h.ctx as never, { tenantId: 'tn_test', skillDir: dir });
    const cleanups = await Promise.all(h.effects);
    const cleanup = cleanups[0] as () => Promise<void>;

    const api = h.provided.get('zhibanKnowledge') as {
      list(): KnowledgeRecord[];
      stats(): { total: number; enabled: number; byCategory: Record<string, number> };
      create(input: { category: string; title: string; content: string }): KnowledgeRecord;
      remove(id: string): KnowledgeRecord;
      sync(): Promise<void>;
    };
    assert.ok(api);
    assert.equal(api.list().length, 30);
    assert.equal(api.stats().enabled, 30);
    assert.equal(api.stats().byCategory['饮食建议'], 6);

    const names = await readdir(dir);
    assert.equal(names.filter((name) => name.startsWith('zhiban-knowledge-')).length, 6);
    assert.ok(h.logs.some((line) => line.includes('已就绪')));

    const handler = h.listeners.get('tools/result')?.[0];
    assert.ok(handler);
    handler!(
      { name: 'reply_draft', arguments: { citedKnowledgeIds: ['knw_seed_01', 'knw_seed_02'] } },
      { isError: false },
    );
    assert.equal(api.list().find((item) => item.id === 'knw_seed_01')?.hits, 1);
    assert.equal(api.list().find((item) => item.id === 'knw_seed_02')?.hits, 1);

    // 工具失败不计命中
    handler!({ name: 'reply_draft', arguments: { citedKnowledgeIds: ['knw_seed_01'] } }, { isError: true });
    assert.equal(api.list().find((item) => item.id === 'knw_seed_01')?.hits, 1);

    // 新增分类 → 立即生成新文件
    const created = api.create({ category: '新分类', title: '新条目', content: '虚构内容。' });
    assert.ok(created.id);
    await api.sync();
    const afterCreate = await readdir(dir);
    assert.equal(afterCreate.filter((name) => name.startsWith('zhiban-knowledge-')).length, 7);

    // 删除唯一一条 → 文件随之删除
    api.remove(created.id);
    await api.sync();
    const afterRemove = await readdir(dir);
    assert.equal(afterRemove.filter((name) => name.startsWith('zhiban-knowledge-')).length, 6);

    await cleanup();
    assert.equal(h.domain.closed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
