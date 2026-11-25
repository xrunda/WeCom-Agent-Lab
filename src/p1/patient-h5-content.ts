/**
 * PH5-08（#237）患者端 H5：食养文化内容库、审核发布与关联。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.11；docs/PATIENT-H5-api.md §9、§12.5。
 *
 * 四条硬规则（issue 验收）：
 * 1. **未审核不发布**：draft / reviewing 对患者完全不可见
 * 2. **经典逐字、出处可查**：classic_quote 必须有 citation；白话与自拟文案
 *    不得署名古籍（数据结构上分开，前端分别标注）
 * 3. **下架即不再推荐**：retired 后列表与详情都不返回正文，旧引用保留版本号
 * 4. **没有适配内容就不强推**：关联查询为空就返回空，不拿无关内容凑
 */
import type { IdFactory } from './ids.ts';

export type ArticleCategory = 'classics_life' | 'ingredients' | 'seasonal_living';

export type SectionKind =
  | 'classic_quote'
  | 'plain_explanation'
  | 'modern_life'
  | 'practice'
  | 'brand_copy';

export type ArticleStatus = 'draft' | 'reviewing' | 'published' | 'retired';

export interface ArticleSection {
  kind: SectionKind;
  text: string;
  /** classic_quote 必填；其他类型不得填写（避免把自拟文案署名古籍） */
  citation?: string;
  /** 经典引用是否已逐字核对 */
  verified?: boolean;
}

export interface IngredientSafety {
  usage: string;
  conditions: string;
  cautions: string;
}

export interface ContentArticle {
  id: string;
  tenantId: string;
  category: ArticleCategory;
  title: string;
  summary: string;
  sections: ArticleSection[];
  authorType: 'editor' | 'professional';
  authorName: string;
  citations: Array<{ text: string; source: string; verified: boolean }>;
  scenarioTags: string[];
  seasonTerm?: string;
  status: ArticleStatus;
  version: number;
  reviewedBy?: string;
  reviewedByName?: string;
  reviewedAt?: number;
  publishedAt?: number;
  retiredAt?: number;
  ingredientSafety?: IngredientSafety;
  createdAt: number;
  updatedAt: number;
}

export class ContentError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'VALIDATION_FAILED'
    | 'CONFLICT'
    | 'FORBIDDEN'
    | 'IMMUTABLE_RESOURCE';

  constructor(code: ContentError['code'], message: string) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
  }
}

export interface ContentBackend {
  load(): ContentArticle[];
  put(record: ContentArticle): Promise<void>;
}

export class MemoryContentBackend implements ContentBackend {
  private readonly records: ContentArticle[] = [];

  load(): ContentArticle[] {
    return [...this.records];
  }

  async put(record: ContentArticle): Promise<void> {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }
}

const CATEGORIES: readonly ArticleCategory[] = [
  'classics_life',
  'ingredients',
  'seasonal_living',
];

/** 校验正文：结构 + 署名规则 + 医疗宣称 */
export function validateArticle(input: {
  title: string;
  summary: string;
  sections: ArticleSection[];
  category: ArticleCategory;
  ingredientSafety?: IngredientSafety;
}): string[] {
  const violations: string[] = [];
  if (!input.title?.trim()) violations.push('标题必填');
  if (input.title?.length > 60) violations.push('标题不超过 60 字');
  if (!input.summary?.trim()) violations.push('摘要必填');
  if (input.summary?.length > 100) violations.push('摘要不超过 100 字');
  if (!CATEGORIES.includes(input.category)) violations.push('分类非法');
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    violations.push('正文不能为空');
    return violations;
  }

  for (const section of input.sections) {
    const text = section.text?.trim() ?? '';
    if (!text) violations.push('正文段落不能为空');
    if (section.kind === 'classic_quote') {
      if (!section.citation?.trim()) {
        violations.push(`经典引用必须写清出处：「${text.slice(0, 12)}…」`);
      }
      if (section.verified !== true) {
        violations.push(`经典引用需标注已逐字核对：「${text.slice(0, 12)}…」`);
      }
    } else if (section.citation) {
      // 白话/自拟文案不能署古籍
      violations.push(`只有经典引用可以标注出处：「${text.slice(0, 12)}…」`);
    }
  }

  const corpus = input.sections.map((item) => item.text).join(' ');
  for (const term of ['治疗', '治愈', '疗效', '抗癌', '降血糖', '根治']) {
    if (corpus.includes(term)) violations.push(`内容包含疗效宣称「${term}」，不允许发布`);
  }

  if (input.category === 'ingredients') {
    const safety = input.ingredientSafety;
    if (!safety?.usage?.trim() || !safety?.conditions?.trim() || !safety?.cautions?.trim()) {
      violations.push('食材类内容必须写明食用方式、适用条件与注意事项');
    }
  }
  return violations;
}

export interface ContentServiceOptions {
  tenantId: string;
  backend: ContentBackend;
  ids: IdFactory;
  now?: () => number;
  onAudit?: (event: { action: string; articleId: string; detail?: Record<string, unknown> }) => void;
}

export class ContentService {
  private readonly tenantId: string;
  private readonly backend: ContentBackend;
  private readonly ids: IdFactory;
  private readonly now: () => number;
  private readonly onAudit?: ContentServiceOptions['onAudit'];

  constructor(options: ContentServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.ids = options.ids;
    this.now = options.now ?? Date.now;
    this.onAudit = options.onAudit;
  }

  // ---------- 编辑侧 ----------

  listForTeam(query: { status?: ArticleStatus; category?: ArticleCategory } = {}): ContentArticle[] {
    return this.backend
      .load()
      .filter((item) => item.tenantId === this.tenantId)
      .filter((item) => (query.status ? item.status === query.status : true))
      .filter((item) => (query.category ? item.category === query.category : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getForTeam(id: string): ContentArticle {
    const found = this.backend
      .load()
      .find((item) => item.tenantId === this.tenantId && item.id === id);
    if (!found) throw new ContentError('NOT_FOUND', '内容不存在');
    return found;
  }

  async create(input: {
    category: ArticleCategory;
    title: string;
    summary: string;
    sections: ArticleSection[];
    authorType: 'editor' | 'professional';
    authorName: string;
    scenarioTags?: string[];
    seasonTerm?: string;
    ingredientSafety?: IngredientSafety;
    actorId: string;
  }): Promise<ContentArticle> {
    const violations = validateArticle(input);
    if (violations.length > 0) throw new ContentError('VALIDATION_FAILED', violations.join('；'));
    const now = this.now();
    const record: ContentArticle = {
      id: this.ids('art'),
      tenantId: this.tenantId,
      category: input.category,
      title: input.title.trim(),
      summary: input.summary.trim(),
      sections: input.sections,
      authorType: input.authorType,
      authorName: input.authorName,
      citations: input.sections
        .filter((section) => section.kind === 'classic_quote' && section.citation)
        .map((section) => ({
          text: section.text.trim(),
          source: section.citation!.trim(),
          verified: section.verified === true,
        })),
      scenarioTags: input.scenarioTags ?? [],
      ...(input.seasonTerm ? { seasonTerm: input.seasonTerm } : {}),
      status: 'draft',
      version: 1,
      ...(input.ingredientSafety ? { ingredientSafety: input.ingredientSafety } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.put(record);
    this.onAudit?.({ action: 'h5.content.create', articleId: record.id, detail: { actorId: input.actorId } });
    return record;
  }

  /** 编辑：版本 +1，回到草稿（已发布的修改要重新审核） */
  async update(input: {
    id: string;
    actorId: string;
    patch: Partial<
      Pick<
        ContentArticle,
        | 'title'
        | 'summary'
        | 'sections'
        | 'scenarioTags'
        | 'seasonTerm'
        | 'ingredientSafety'
        | 'category'
        | 'authorName'
        | 'authorType'
      >
    >;
  }): Promise<ContentArticle> {
    const record = this.getForTeam(input.id);
    const merged = {
      title: input.patch.title ?? record.title,
      summary: input.patch.summary ?? record.summary,
      sections: input.patch.sections ?? record.sections,
      category: input.patch.category ?? record.category,
      ingredientSafety: input.patch.ingredientSafety ?? record.ingredientSafety,
    };
    const violations = validateArticle(merged);
    if (violations.length > 0) throw new ContentError('VALIDATION_FAILED', violations.join('；'));

    const next: ContentArticle = {
      ...record,
      ...input.patch,
      version: record.version + 1,
      status: 'draft',
      updatedAt: this.now(),
    };
    next.citations = merged.sections
      .filter((section) => section.kind === 'classic_quote' && section.citation)
      .map((section) => ({
        text: section.text.trim(),
        source: section.citation!.trim(),
        verified: section.verified === true,
      }));
    await this.backend.put(next);
    this.onAudit?.({ action: 'h5.content.update', articleId: next.id, detail: { actorId: input.actorId } });
    return next;
  }

  async submitReview(input: { id: string; actorId: string }): Promise<ContentArticle> {
    const record = this.getForTeam(input.id);
    if (record.status !== 'draft') throw new ContentError('CONFLICT', '只有草稿可以提交审核');
    const next: ContentArticle = { ...record, status: 'reviewing', updatedAt: this.now() };
    await this.backend.put(next);
    return next;
  }

  /** 发布：必须审核通过（能力校验由调用方做） */
  async publish(input: {
    id: string;
    reviewerAccountId: string;
    reviewerName: string;
  }): Promise<ContentArticle> {
    const record = this.getForTeam(input.id);
    if (record.status !== 'reviewing') {
      throw new ContentError('CONFLICT', '只有待审核内容可以发布');
    }
    // 再审一次：防止编辑绕过校验
    const violations = validateArticle(record);
    if (violations.length > 0) {
      throw new ContentError('VALIDATION_FAILED', violations.join('；'));
    }
    const now = this.now();
    const next: ContentArticle = {
      ...record,
      status: 'published',
      reviewedBy: input.reviewerAccountId,
      reviewedByName: input.reviewerName,
      reviewedAt: now,
      publishedAt: now,
      updatedAt: now,
    };
    await this.backend.put(next);
    this.onAudit?.({ action: 'h5.content.publish', articleId: next.id });
    return next;
  }

  async retire(input: { id: string; actorId: string }): Promise<ContentArticle> {
    const record = this.getForTeam(input.id);
    if (record.status !== 'published') throw new ContentError('CONFLICT', '只有已发布内容可以下架');
    const now = this.now();
    const next: ContentArticle = { ...record, status: 'retired', retiredAt: now, updatedAt: now };
    await this.backend.put(next);
    this.onAudit?.({ action: 'h5.content.retire', articleId: next.id, detail: { actorId: input.actorId } });
    return next;
  }

  // ---------- 患者侧 ----------

  /** 列表只返回已发布；下架后不再出现 */
  listPublished(query: { category?: ArticleCategory } = {}): ContentArticle[] {
    return this.backend
      .load()
      .filter((item) => item.tenantId === this.tenantId && item.status === 'published')
      .filter((item) => (query.category ? item.category === query.category : true))
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  }

  /** 详情：下架返回 NOT_FOUND（前端显示「内容已更新」） */
  getPublished(id: string): ContentArticle {
    const found = this.backend
      .load()
      .find((item) => item.tenantId === this.tenantId && item.id === id);
    if (!found || found.status !== 'published') {
      throw new ContentError('NOT_FOUND', '内容不存在或已下架');
    }
    return found;
  }

  /**
   * 按场景关联内容。空结果就是空，不拿无关内容凑（PRD §9）。
   * 只从已发布内容里选；节气只作为线索，不据此自动给统一处方。
   */
  related(query: { tags: string[]; category?: ArticleCategory; limit?: number }): ContentArticle[] {
    if (query.tags.length === 0) return [];
    const matched = this.listPublished({
      ...(query.category ? { category: query.category } : {}),
    }).filter((item) => item.scenarioTags.some((tag) => query.tags.includes(tag)));
    return matched.slice(0, query.limit ?? 3);
  }
}
