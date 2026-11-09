/**
 * zhiban-knowledge DSH 插件入口（#38）。
 *
 * 装配顺序：
 *   打开知识领域 → 幂等写入 30 条示例 → 按分类生成 skill 文件 →
 *   监听 reply_draft 的 citedKnowledgeIds 累加命中 → 提供 `zhibanKnowledge`。
 *
 * skill 文件是纯文本，不含密钥；文件名用分类哈希，内容带条目 id 供引用。
 * 条目增删改后立即重写文件；Agent 下一轮由文件系统 skill provider 重新读取。
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import {
  buildSkillFiles,
  KnowledgeService,
  syncSkillFiles,
} from '../../src/p1/knowledge.ts';
import type {
  KnowledgeCreateInput,
  KnowledgeQuery,
  KnowledgeRecord,
  KnowledgeUpdateInput,
  SkillFileStore,
} from '../../src/p1/knowledge.ts';
import { EXAMPLE_KNOWLEDGE } from '../../src/p1/knowledge-seed.ts';
import type { AuditEvent } from '../../src/c2/types.ts';

import { parseKnowledgeConfig } from './config.ts';
import { DomainKnowledgeBackend, knowledgeDomain } from './domain.ts';

export const name = 'zhiban-knowledge';

/** storageDomain 由 dsh-storage-domain 提供；tools 由宿主提供 */
export const inject = ['storageDomain'];

type EffectCleanup = void | (() => void | Promise<void>);

export interface DshKnowledgeContext {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => EffectCleanup | Promise<EffectCleanup>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
}

export interface KnowledgeStats {
  total: number;
  enabled: number;
  byCategory: Record<string, number>;
}

/** 提供给控制台 / 管理接口的视图 */
export interface KnowledgeRuntimeApi {
  list(query?: KnowledgeQuery): KnowledgeRecord[];
  get(id: string): KnowledgeRecord | undefined;
  create(input: KnowledgeCreateInput): KnowledgeRecord;
  update(id: string, patch: KnowledgeUpdateInput): KnowledgeRecord;
  remove(id: string): KnowledgeRecord;
  categories(): string[];
  stats(): KnowledgeStats;
  recordCitations(ids: string[]): number;
  sync(): Promise<void>;
  audits(): AuditEvent[];
  flush(): Promise<void>;
}

/** 只读目录 → 列出 .md、写、删；目录不存在时 list 返回空 */
export function createFsSkillStore(dir: string): SkillFileStore {
  return {
    async list() {
      try {
        const names = await readdir(dir);
        return names.filter((item) => item.endsWith('.md'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    async write(fileName, content) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, fileName), content, 'utf8');
    },
    async remove(fileName) {
      await rm(join(dir, fileName), { force: true });
    },
  };
}

function extractCitedKnowledgeIds(args: unknown): string[] {
  if (args === null || typeof args !== 'object') return [];
  const value = (args as { citedKnowledgeIds?: unknown }).citedKnowledgeIds;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

export function apply(ctx: DshKnowledgeContext, rawConfig: unknown): void {
  const config = parseKnowledgeConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-knowledge] ${line}`);

  log(`加载配置：租户=${config.tenantId} skillDir=${config.skillDir}`);

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(knowledgeDomain);
    const backend = new DomainKnowledgeBackend(domain);
    const store = createFsSkillStore(config.skillDir);

    let syncChain: Promise<void> = Promise.resolve();
    let service: KnowledgeService | undefined;

    const scheduleSync = (reason: string): Promise<void> => {
      syncChain = syncChain
        .then(async () => {
          if (!service) return;
          await syncSkillFiles(store, buildSkillFiles(service.list()));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log(`skill 文件生成失败（${reason}）：${message}`);
          ctx.emit('alert.created', {
            kind: 'SKILL_SYNC_FAILED',
            message: `知识 skill 文件生成失败：${message}`,
            at: Date.now(),
          });
        });
      return syncChain;
    };

    try {
      service = new KnowledgeService({
        tenantId: config.tenantId,
        backend,
        emit: (type, data) => {
          ctx.emit(type, data);
          if (
            type === 'knowledge.created' ||
            type === 'knowledge.updated' ||
            type === 'knowledge.deleted' ||
            type === 'knowledge.seeded'
          ) {
            void scheduleSync(type);
          }
        },
        onAudit: (event) => {
          void backend.appendAudit(event);
          ctx.emit('audit', event);
        },
        onPersistError: (error) => {
          log(`领域存储写入失败：${error.message}`);
          ctx.emit('alert.created', {
            kind: 'PERSIST_FAILED',
            message: `知识库存储写入失败：${error.message}`,
            at: Date.now(),
          });
        },
      });

      if (config.seedExamples) {
        const added = service.seed(EXAMPLE_KNOWLEDGE);
        if (added > 0) log(`已写入 ${added} 条示例知识`);
      }

      let offTools: unknown;
      offTools = ctx.on?.('tools/result', (...args) => {
        const exec = args[0] as { name?: unknown; arguments?: unknown } | undefined;
        const result = args[1] as { isError?: unknown } | undefined;
        if (!exec || exec.name !== 'reply_draft') return;
        if (result?.isError === true) return;
        const ids = extractCitedKnowledgeIds(exec.arguments);
        if (ids.length === 0 || !service) return;
        const changed = service.recordCitations(ids);
        if (changed > 0) log(`引用命中 +${changed}`);
      });

      await scheduleSync('startup');

      const api: KnowledgeRuntimeApi = {
        list: (query) => service!.list(query),
        get: (id) => service!.get(id),
        create: (input) => service!.create(input),
        update: (id, patch) => service!.update(id, patch),
        remove: (id) => service!.remove(id),
        categories: () => service!.categories(),
        stats: () => {
          const all = service!.list();
          const byCategory: Record<string, number> = {};
          for (const record of all) {
            byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
          }
          return {
            total: all.length,
            enabled: all.filter((record) => record.enabled).length,
            byCategory,
          };
        },
        recordCitations: (ids) => service!.recordCitations(ids),
        sync: () => scheduleSync('manual'),
        audits: () => service!.audits(),
        flush: () => service!.flush(),
      };
      ctx.provide('zhibanKnowledge', api);

      log(
        `已就绪：${service.count()} 条知识，${service.categories().length} 个分类，` +
          `skill 目录 ${config.skillDir}`,
      );

      return async () => {
        if (typeof offTools === 'function') (offTools as () => void)();
        await syncChain;
        await service?.flush();
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      await service?.flush();
      await domain.close();
      throw error;
    }
  });
}
