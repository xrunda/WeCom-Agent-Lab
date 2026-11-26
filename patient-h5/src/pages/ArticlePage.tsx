/**
 * 食养文章详情（H08，契约 api §9.3）。
 *
 * 经典原文与白话解释分别标注、出处可核对；自拟文案不署名古籍。
 * 内容下架后接口返回 404，页面显示「内容已更新」。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchArticleDetail, type ArticleDetailView } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { ASSETS } from '../assets.ts';

const KIND_LABEL: Record<string, string> = {
  classic_quote: '经典原文',
  plain_explanation: '白话解释',
  modern_life: '生活中的理解',
  practice: '可以这样做',
  brand_copy: '服务说明',
};

interface Props {
  articleId: string;
  onBack: () => void;
  onUnauthorized: () => void;
}

export function ArticlePage({ articleId, onBack, onUnauthorized }: Props) {
  const [article, setArticle] = useState<ArticleDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchArticleDetail(articleId)
      .then(setArticle)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else setError('内容已更新');
      });
  }, [articleId, onUnauthorized]);

  return (
    <div className="page">
      <button type="button" className="link-btn plan-back" onClick={onBack}>
        ‹ 返回
      </button>

      {error && (
        <div className="card">
          <p className="muted">{error}</p>
        </div>
      )}

      {article && (
        <>
          <header className="article-detail__head">
            <h1>{article.title}</h1>
            <p className="muted">
              {article.authorName} · 专业审核 · 第 {article.version} 版
            </p>
          </header>

          <AssetSlot
            id="P06"
            ratio="16 / 9"
            radius={12}
            src={article.coverUrl ?? ASSETS.mealSquare}
            label="文章配图"
            className="article-detail__cover"
          />

          <div className="article-detail__body">
            {article.sections.map((section, index) => (
              <section
                key={`${section.kind}-${index}`}
                className={section.kind === 'classic_quote' ? 'classic-block' : 'plain-block'}
              >
                {section.kind === 'classic_quote' ? (
                  <>
                    <blockquote className="classic">{section.text}</blockquote>
                    {section.citation && <p className="citation">出处：{section.citation}</p>}
                  </>
                ) : (
                  <p>{section.text}</p>
                )}
                <span className="kind-tag">{KIND_LABEL[section.kind] ?? section.kind}</span>
              </section>
            ))}
          </div>

          {article.ingredientSafety && (
            <section className="card">
              <h2>食用方式与注意</h2>
              <div className="status-line">
                <span className="label">日常吃法</span>
                <span>{article.ingredientSafety.usage}</span>
              </div>
              <div className="status-line">
                <span className="label">适合人群</span>
                <span>{article.ingredientSafety.conditions}</span>
              </div>
              <div className="status-line">
                <span className="label">注意事项</span>
                <span>{article.ingredientSafety.cautions}</span>
              </div>
            </section>
          )}

          <p className="muted article-detail__foot">
            本文经专业审核后发布；不构成诊断或用药建议。
          </p>
        </>
      )}

      <div className="footer-space" />
    </div>
  );
}
