/**
 * PH5-08（#237）内容维护接口（契约 api §12.5）。
 *
 * 编辑与审核分开授权：h5.content.edit / h5.content.review，默认都不授予。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import { ContentError } from '../../../src/p1/patient-h5-content.ts';
import type { ArticleStatus, ContentArticle, ContentService } from '../../../src/p1/patient-h5-content.ts';
import type { AuthActor } from '../auth.ts';
import { jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

export interface ContentRouteDeps {
  router: Router;
  getContent: () => ContentService | undefined;
  tenantActor: (rc: RouteContext) => AuthActor;
  audit: (actor: AuthActor, action: string, article: ContentArticle) => void;
}

function requireCapability(actor: AuthActor, capability: string, label: string): void {
  const granted = (actor.account as { h5Permissions?: string[] }).h5Permissions ?? [];
  if (!granted.includes(capability)) {
    throw new ConsoleError('FORBIDDEN', `当前账号没有${label}能力，请联系管理员开通`);
  }
}

function toConsoleError(error: unknown): never {
  if (error instanceof ContentError) {
    const map = {
      NOT_FOUND: 'NOT_FOUND',
      VALIDATION_FAILED: 'VALIDATION_FAILED',
      CONFLICT: 'CONFLICT',
      FORBIDDEN: 'FORBIDDEN',
      IMMUTABLE_RESOURCE: 'IMMUTABLE_RESOURCE',
    } as const;
    throw new ConsoleError(map[error.code], error.message);
  }
  throw error;
}

export function registerPatientH5ContentRoutes(deps: ContentRouteDeps): void {
  const { router } = deps;
  const api = (): ContentService => {
    const instance = deps.getContent();
    if (!instance) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
    return instance;
  };

  router.add(
    'GET',
    '/content-articles',
    (rc) => {
      deps.tenantActor(rc);
      const statusRaw = rc.query.get('status');
      const status =
        statusRaw === 'draft' ||
        statusRaw === 'reviewing' ||
        statusRaw === 'published' ||
        statusRaw === 'retired'
          ? (statusRaw as ArticleStatus)
          : undefined;
      const categoryRaw = rc.query.get('category');
      const category =
        categoryRaw === 'classics_life' ||
        categoryRaw === 'ingredients' ||
        categoryRaw === 'seasonal_living'
          ? (categoryRaw as never)
          : undefined;
      const items = api().listForTeam({
        ...(status ? { status } : {}),
        ...(category ? { category } : {}),
      });
      jsonResponse(rc.res, 200, { items }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'GET',
    '/content-articles/:id',
    (rc) => {
      deps.tenantActor(rc);
      jsonResponse(rc.res, 200, { article: api().getForTeam(String(rc.params.id ?? '')) }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/content-articles',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      requireCapability(actor, 'h5.content.edit', '内容编辑');
      const body = await rc.json<Record<string, unknown>>();
      try {
        const article = await api().create({
          category: body.category as never,
          title: String(body.title ?? ''),
          summary: String(body.summary ?? ''),
          sections: (body.sections ?? []) as never,
          authorType: (body.authorType as never) ?? 'editor',
          authorName: String(body.authorName ?? '编辑部'),
          scenarioTags: Array.isArray(body.scenarioTags) ? (body.scenarioTags as string[]) : [],
          ...(typeof body.seasonTerm === 'string' ? { seasonTerm: body.seasonTerm } : {}),
          ...(body.ingredientSafety ? { ingredientSafety: body.ingredientSafety as never } : {}),
          actorId: actor.account.id,
        });
        deps.audit(actor, 'h5.content.create', article);
        jsonResponse(rc.res, 201, { article }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'PATCH',
    '/content-articles/:id',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      requireCapability(actor, 'h5.content.edit', '内容编辑');
      const body = await rc.json<Record<string, unknown>>();
      try {
        const article = await api().update({
          id: String(rc.params.id ?? ''),
          actorId: actor.account.id,
          patch: body as never,
        });
        deps.audit(actor, 'h5.content.update', article);
        jsonResponse(rc.res, 200, { article }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/content-articles/:id/submit-review',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      requireCapability(actor, 'h5.content.edit', '内容编辑');
      try {
        const article = await api().submitReview({
          id: String(rc.params.id ?? ''),
          actorId: actor.account.id,
        });
        jsonResponse(rc.res, 200, { article }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/content-articles/:id/publish',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      requireCapability(actor, 'h5.content.review', '内容审核');
      try {
        const article = await api().publish({
          id: String(rc.params.id ?? ''),
          reviewerAccountId: actor.account.id,
          reviewerName: actor.account.displayName,
        });
        deps.audit(actor, 'h5.content.publish', article);
        jsonResponse(rc.res, 200, { article }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/content-articles/:id/retire',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      requireCapability(actor, 'h5.content.review', '内容审核');
      try {
        const article = await api().retire({
          id: String(rc.params.id ?? ''),
          actorId: actor.account.id,
        });
        deps.audit(actor, 'h5.content.retire', article);
        jsonResponse(rc.res, 200, { article }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );
}
