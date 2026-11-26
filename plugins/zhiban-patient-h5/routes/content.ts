/**
 * PH5-08（#237）患者侧内容路由（契约 api §9）。
 *
 * 只返回已发布内容；下架返回 404，前端显示「内容已更新」。
 */
import { H5Error } from '../../../src/p1/patient-h5.ts';
import { ContentError } from '../../../src/p1/patient-h5-content.ts';
import type { ArticleCategory, ContentService } from '../../../src/p1/patient-h5-content.ts';
import type { H5RouteExtension } from '../http.ts';

const CATEGORIES: readonly ArticleCategory[] = ['classics_life', 'ingredients', 'seasonal_living'];

function view(article: ReturnType<ContentService['getPublished']>) {
  return {
    id: article.id,
    category: article.category,
    title: article.title,
    summary: article.summary,
    coverUrl: article.coverUrl ?? null,
    sections: article.sections,
    authorName: article.authorName,
    authorType: article.authorType,
    citations: article.citations,
    scenarioTags: article.scenarioTags,
    ...(article.seasonTerm ? { seasonTerm: article.seasonTerm } : {}),
    ...(article.ingredientSafety ? { ingredientSafety: article.ingredientSafety } : {}),
    publishedAt: article.publishedAt ?? null,
    reviewedAt: article.reviewedAt ?? null,
    version: article.version,
  };
}

export function createContentRoutes(options: { content: ContentService }): H5RouteExtension[] {
  /** GET /articles?category= */
  const list: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/articles' || ctx.method !== 'GET') return false;
    await ctx.requireSession();
    const raw = ctx.query.get('category');
    const category = CATEGORIES.includes(raw as ArticleCategory)
      ? (raw as ArticleCategory)
      : undefined;
    ctx.ok(200, {
      items: options.content
        .listPublished(category ? { category } : {})
        .map((item) => ({
          id: item.id,
          category: item.category,
          title: item.title,
          summary: item.summary,
          coverUrl: item.coverUrl ?? null,
          publishedAt: item.publishedAt ?? null,
          seasonTerm: item.seasonTerm ?? null,
          // 实践段的第一句作为「今天就能做的一件小事」，没有就不返回
          microAction:
            item.sections.find((section) => section.kind === 'practice')?.text?.slice(0, 60) ?? null,
          scenarioTags: item.scenarioTags,
        })),
    });
    return true;
  };

  /** GET /articles/related?tags=a,b&category= */
  const related: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/articles/related' || ctx.method !== 'GET') return false;
    await ctx.requireSession();
    const tags = (ctx.query.get('tags') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const raw = ctx.query.get('category');
    const category = CATEGORIES.includes(raw as ArticleCategory)
      ? (raw as ArticleCategory)
      : undefined;
    ctx.ok(200, {
      items: options.content
        .related({ tags, ...(category ? { category } : {}) })
        .map((item) => ({ id: item.id, title: item.title, category: item.category })),
    });
    return true;
  };

  /** GET /articles/:id */
  const detail: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/articles\/([^/]+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    await ctx.requireSession();
    try {
      ctx.ok(200, view(options.content.getPublished(match[1]!)));
    } catch (error) {
      if (error instanceof ContentError) throw new H5Error('NOT_FOUND', '内容已更新');
      throw error;
    }
    return true;
  };

  return [related, detail, list];
}
