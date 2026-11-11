/**
 * WP-H / #120 话术库控制台接口（docs/P1-api.md §10）。
 *
 * 话术是给顾问查询、复制到企微的机构内容，不参与 Agent 草稿生成，
 * 因此不新建运行时插件：条目直接落在控制台域的 `scripts` 表，
 * 由 `ConsoleStore` 负责内存镜像与串行落盘。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import {
  SCRIPT_CATEGORY_MAX,
  SCRIPT_CONTENT_MAX,
  SCRIPT_TAG_MAX,
  SCRIPT_TAGS_MAX,
  SCRIPT_TITLE_MAX,
  type ScriptRecord,
} from '../../../src/p1/console-types.ts';
import type { AuthActor } from '../auth.ts';
import { emptyResponse, jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

/** 只依赖存储中用到的四个方法，便于单测直接替换 */
export interface ScriptStoreApi {
  newId(prefix: string): string;
  getScript(id: string): ScriptRecord | undefined;
  listScripts(): ScriptRecord[];
  saveScript(record: ScriptRecord): void;
}

export interface ScriptAuditDetail {
  scriptId: string;
  category: string;
  title: string;
  /** 本次改动的字段名；不含正文 */
  fields?: string[];
}

export interface ScriptRouteDeps {
  router: Router;
  store: ScriptStoreApi;
  tenantId: string;
  tenantActor: (rc: RouteContext) => AuthActor;
  audit: (
    actor: AuthActor,
    action: 'script.created' | 'script.updated' | 'script.deleted',
    detail: ScriptAuditDetail,
  ) => void;
  now?: () => number;
}

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConsoleError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

function textField(
  body: Record<string, unknown>,
  field: string,
  max: number,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 不能为空`, [
      { field, issue: 'empty' },
    ]);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 不能超过 ${max} 字`, [
      { field, issue: `max ${max}` },
    ]);
  }
  return text;
}

function tagsField(body: Record<string, unknown>): string[] {
  const value = body.tags;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConsoleError('VALIDATION_FAILED', 'tags 必须是字符串数组', [
      { field: 'tags', issue: 'not array' },
    ]);
  }
  if (value.length > SCRIPT_TAGS_MAX) {
    throw new ConsoleError('VALIDATION_FAILED', `tags 最多 ${SCRIPT_TAGS_MAX} 个`, [
      { field: 'tags', issue: `max ${SCRIPT_TAGS_MAX}` },
    ]);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ConsoleError('VALIDATION_FAILED', 'tags 必须是字符串数组', [
        { field: 'tags', issue: 'not string' },
      ]);
    }
    const tag = item.trim();
    if (tag === '' || tag.length > SCRIPT_TAG_MAX) {
      throw new ConsoleError(
        'VALIDATION_FAILED',
        `标签长度需为 1–${SCRIPT_TAG_MAX} 字`,
        [{ field: 'tags', issue: 'invalid tag' }],
      );
    }
    if (!result.includes(tag)) result.push(tag);
  }
  return result;
}

function enabledField(body: Record<string, unknown>): boolean | undefined {
  const value = body.enabled;
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConsoleError('VALIDATION_FAILED', 'enabled 必须是布尔值', [
      { field: 'enabled', issue: 'not boolean' },
    ]);
  }
  return value;
}

/** 未删除的话术才可读、可改；软删除后再操作按不存在处理。 */
function findActive(store: ScriptStoreApi, id: string): ScriptRecord {
  const record = store.getScript(id);
  if (!record || record.deletedAt !== undefined) {
    throw new ConsoleError('NOT_FOUND', '话术不存在');
  }
  return record;
}

export function registerScriptRoutes(deps: ScriptRouteDeps): void {
  const { router, store, tenantId, tenantActor, audit } = deps;
  const now = deps.now ?? (() => Date.now());

  const listItems = (): ScriptRecord[] =>
    store
      .listScripts()
      .filter((record) => record.deletedAt === undefined)
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category, 'zh-CN') ||
          a.title.localeCompare(b.title, 'zh-CN'),
      );

  router.add(
    'GET',
    '/scripts',
    (rc) => {
      tenantActor(rc);
      const enabledRaw = rc.query.get('enabled');
      let enabled: boolean | undefined;
      if (enabledRaw !== null && enabledRaw !== '') {
        if (enabledRaw !== 'true' && enabledRaw !== 'false') {
          throw new ConsoleError('VALIDATION_FAILED', 'enabled 必须是 true 或 false');
        }
        enabled = enabledRaw === 'true';
      }
      const category = rc.query.get('category')?.trim();
      const q = rc.query.get('q')?.trim().toLowerCase();
      let items = listItems();
      if (category) items = items.filter((item) => item.category === category);
      if (enabled !== undefined) items = items.filter((item) => item.enabled === enabled);
      if (q) {
        items = items.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.content.toLowerCase().includes(q) ||
            item.tags.some((tag) => tag.toLowerCase().includes(q)),
        );
      }
      jsonResponse(
        rc.res,
        200,
        { items, total: items.length, sample: false },
        rc.requestId,
      );
    },
    { permission: 'tenant.read' },
  );

  router.add(
    'POST',
    '/scripts',
    async (rc) => {
      const actor = tenantActor(rc);
      const body = assertObject(await rc.json<unknown>());
      const at = now();
      const record: ScriptRecord = {
        id: store.newId('scr'),
        tenantId,
        category: textField(body, 'category', SCRIPT_CATEGORY_MAX),
        title: textField(body, 'title', SCRIPT_TITLE_MAX),
        content: textField(body, 'content', SCRIPT_CONTENT_MAX),
        tags: tagsField(body),
        enabled: enabledField(body) ?? true,
        createdAt: at,
        updatedAt: at,
      };
      store.saveScript(record);
      audit(actor, 'script.created', {
        scriptId: record.id,
        category: record.category,
        title: record.title,
      });
      jsonResponse(rc.res, 201, record, rc.requestId);
    },
    { permission: 'tenant.write' },
  );

  router.add(
    'PATCH',
    '/scripts/:id',
    async (rc) => {
      const actor = tenantActor(rc);
      const existing = findActive(store, rc.params.id!);
      const body = assertObject(await rc.json<unknown>());
      const fields: string[] = [];
      const next: ScriptRecord = { ...existing };
      if (body.category !== undefined) {
        next.category = textField(body, 'category', SCRIPT_CATEGORY_MAX);
        fields.push('category');
      }
      if (body.title !== undefined) {
        next.title = textField(body, 'title', SCRIPT_TITLE_MAX);
        fields.push('title');
      }
      if (body.content !== undefined) {
        next.content = textField(body, 'content', SCRIPT_CONTENT_MAX);
        fields.push('content');
      }
      if (body.tags !== undefined) {
        next.tags = tagsField(body);
        fields.push('tags');
      }
      if (body.enabled !== undefined) {
        next.enabled = enabledField(body)!;
        fields.push('enabled');
      }
      if (fields.length === 0) {
        throw new ConsoleError('VALIDATION_FAILED', '至少提供一个可更新字段');
      }
      next.updatedAt = now();
      store.saveScript(next);
      audit(actor, 'script.updated', {
        scriptId: next.id,
        category: next.category,
        title: next.title,
        fields,
      });
      jsonResponse(rc.res, 200, next, rc.requestId);
    },
    { permission: 'tenant.write' },
  );

  router.add(
    'DELETE',
    '/scripts/:id',
    (rc) => {
      const actor = tenantActor(rc);
      const existing = findActive(store, rc.params.id!);
      const at = now();
      store.saveScript({ ...existing, deletedAt: at, updatedAt: at });
      audit(actor, 'script.deleted', {
        scriptId: existing.id,
        category: existing.category,
        title: existing.title,
      });
      emptyResponse(rc.res, 204, rc.requestId);
    },
    { permission: 'tenant.write' },
  );
}
