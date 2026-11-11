/**
 * WP-H / #118 知识库控制台接口（docs/P1-api.md §10）。
 *
 * 只做 HTTP 适配：校验、分页、重复标题与控制台审计。
 * 条目的存储、skill 资源重写和命中统计都由 `zhiban-knowledge` 负责，
 * 控制台通过 `ctx.get('zhibanKnowledge')` 调用，不直接读写知识存储。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import type {
  KnowledgeCreateInput,
  KnowledgeQuery,
  KnowledgeRecord,
  KnowledgeUpdateInput,
} from '../../../src/p1/knowledge.ts';
import type { AuthActor } from '../auth.ts';
import { emptyResponse, jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

export interface KnowledgeApi {
  list?(query?: KnowledgeQuery): KnowledgeRecord[];
  get?(id: string): KnowledgeRecord | undefined;
  create?(input: KnowledgeCreateInput): KnowledgeRecord;
  update?(id: string, patch: KnowledgeUpdateInput): KnowledgeRecord;
  remove?(id: string): KnowledgeRecord;
  categories?(): string[];
}

export interface KnowledgeRouteDeps {
  router: Router;
  getKnowledge: () => KnowledgeApi | undefined;
  /** platform 角色一律 404，由调用方注入 */
  tenantActor: (rc: RouteContext) => AuthActor;
  audit: (
    actor: AuthActor,
    action: 'knowledge.created' | 'knowledge.updated' | 'knowledge.deleted',
    record: KnowledgeRecord,
  ) => void;
}

const DEFAULT_PAGE_SIZE = 50;
/** 前端知识库一次拉 200 条；上限与前端一致，不套用全局 100 条的分页上限 */
const MAX_PAGE_SIZE = 200;

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function knowledgeView(
  record: KnowledgeRecord,
): Omit<KnowledgeRecord, 'deletedAt'> & { deletedAt: number | null } {
  // 前端类型把未删除写成 null；后端记录用 undefined。
  return { ...record, deletedAt: record.deletedAt ?? null };
}

/** 与 `KnowledgeError.code` 对齐；按消息前缀映射，避免跨插件实例的 instanceof 失效。 */
const KNOWLEDGE_VALIDATION_CODES = new Set([
  'EMPTY_CATEGORY',
  'CATEGORY_TOO_LONG',
  'EMPTY_TITLE',
  'TITLE_TOO_LONG',
  'EMPTY_CONTENT',
  'CONTENT_TOO_LONG',
]);

function mapKnowledgeError(error: unknown): never {
  if (error instanceof ConsoleError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const [code, ...rest] = message.split(': ');
  if (code === 'NOT_FOUND') throw new ConsoleError('NOT_FOUND', '知识条目不存在');
  if (code !== undefined && KNOWLEDGE_VALIDATION_CODES.has(code)) {
    throw new ConsoleError('VALIDATION_FAILED', rest.join(': ') || message);
  }
  throw error;
}

function requireApi(api: KnowledgeApi | undefined): Required<KnowledgeApi> {
  if (
    !api?.list ||
    !api.get ||
    !api.create ||
    !api.update ||
    !api.remove ||
    !api.categories
  ) {
    throw new ConsoleError('UPSTREAM_UNAVAILABLE', '知识库未就绪');
  }
  return api as Required<KnowledgeApi>;
}

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConsoleError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 必须是字符串`);
  }
  return value;
}

function optionalText(body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  return textField(body, field);
}

function optionalEnabled(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 必须是布尔值`);
  }
  return value;
}

/** 同分类同标题视为重复；跨分类允许同名。 */
function assertUniqueTitle(
  api: Required<KnowledgeApi>,
  category: string,
  title: string,
  excludeId?: string,
): void {
  const duplicate = api
    .list()
    .some(
      (record) =>
        record.id !== excludeId &&
        record.category === category &&
        record.title === title,
    );
  if (duplicate) {
    throw new ConsoleError('CONFLICT', '同一分类下已存在同名知识条目', [
      { field: 'title', issue: '重复' },
    ]);
  }
}

function findActive(api: Required<KnowledgeApi>, id: string): KnowledgeRecord {
  const record = api.get(id);
  if (!record || record.deletedAt !== undefined) {
    throw new ConsoleError('NOT_FOUND', '知识条目不存在');
  }
  return record;
}

export function registerKnowledgeRoutes(deps: KnowledgeRouteDeps): void {
  const { router, tenantActor, audit } = deps;

  router.add(
    'GET',
    '/knowledge',
    (rc) => {
      tenantActor(rc);
      const api = requireApi(deps.getKnowledge());
      const enabledRaw = rc.query.get('enabled');
      let enabled: boolean | undefined;
      if (enabledRaw !== null && enabledRaw !== '') {
        if (enabledRaw !== 'true' && enabledRaw !== 'false') {
          throw new ConsoleError('VALIDATION_FAILED', 'enabled 必须是 true 或 false');
        }
        enabled = enabledRaw === 'true';
      }
      const page = positiveInt(rc.query.get('page'), 1);
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        positiveInt(rc.query.get('pageSize'), DEFAULT_PAGE_SIZE),
      );
      const q = rc.query.get('q')?.trim();
      const items = api.list({
        category: rc.query.get('category') ?? undefined,
        enabled,
        q: q || undefined,
      });
      const start = (page - 1) * pageSize;
      jsonResponse(
        rc.res,
        200,
        {
          items: items.slice(start, start + pageSize).map(knowledgeView),
          page,
          pageSize,
          total: items.length,
        },
        rc.requestId,
      );
    },
    { permission: 'tenant.read' },
  );

  router.add(
    'GET',
    '/knowledge/categories',
    (rc) => {
      tenantActor(rc);
      const api = requireApi(deps.getKnowledge());
      const records = api.list();
      const counts = new Map<string, number>();
      for (const record of records) {
        counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
      }
      const items = [...counts.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category, 'zh-CN'));
      jsonResponse(rc.res, 200, { items }, rc.requestId);
    },
    { permission: 'tenant.read' },
  );

  router.add(
    'POST',
    '/knowledge',
    async (rc) => {
      const actor = tenantActor(rc);
      const api = requireApi(deps.getKnowledge());
      const body = assertObject(await rc.json<unknown>());
      let record: KnowledgeRecord;
      try {
        const category = textField(body, 'category').trim();
        const title = textField(body, 'title').trim();
        const content = textField(body, 'content').trim();
        const enabled = optionalEnabled(body, 'enabled');
        assertUniqueTitle(api, category, title);
        record = api.create({ category, title, content, enabled });
      } catch (error) {
        mapKnowledgeError(error);
      }
      audit(actor, 'knowledge.created', record);
      jsonResponse(rc.res, 201, knowledgeView(record), rc.requestId);
    },
    { permission: 'tenant.write' },
  );

  router.add(
    'PATCH',
    '/knowledge/:id',
    async (rc) => {
      const actor = tenantActor(rc);
      const api = requireApi(deps.getKnowledge());
      const existing = findActive(api, rc.params.id!);
      const body = assertObject(await rc.json<unknown>());
      let record: KnowledgeRecord;
      try {
        const category = optionalText(body, 'category')?.trim();
        const title = optionalText(body, 'title')?.trim();
        const content = optionalText(body, 'content')?.trim();
        const enabled = optionalEnabled(body, 'enabled');
        assertUniqueTitle(
          api,
          category ?? existing.category,
          title ?? existing.title,
          existing.id,
        );
        record = api.update(existing.id, { category, title, content, enabled });
      } catch (error) {
        mapKnowledgeError(error);
      }
      audit(actor, 'knowledge.updated', record);
      jsonResponse(rc.res, 200, knowledgeView(record), rc.requestId);
    },
    { permission: 'tenant.write' },
  );

  router.add(
    'DELETE',
    '/knowledge/:id',
    (rc) => {
      const actor = tenantActor(rc);
      const api = requireApi(deps.getKnowledge());
      const existing = api.get(rc.params.id!);
      let record: KnowledgeRecord;
      try {
        record = api.remove(rc.params.id!);
      } catch (error) {
        mapKnowledgeError(error);
      }
      // 重复删除保持幂等，但不重复记审计。
      if (existing && existing.deletedAt === undefined) {
        audit(actor, 'knowledge.deleted', record);
      }
      emptyResponse(rc.res, 204, rc.requestId);
    },
    { permission: 'tenant.write' },
  );
}
