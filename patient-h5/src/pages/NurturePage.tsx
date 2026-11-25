/**
 * 食养栏目（H08，契约 api §9.2）。
 *
 * - 首次引导模式（intro）：只显示食养主张，可跳过（H01）
 * - 常态：品牌行 → 标题 → 分类切换 → 精选文章 → 与计划有关 → 文章列表
 *
 * 刻意不渲染搜索框：PRD §3.1 把搜索列为增强项，未实现时隐藏，不放无效按钮。
 * 文章只读已发布内容；停用内容不展示正文（A09）。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchArticles, fetchManifesto } from '../api.ts';
import type { ArticleView, Manifesto } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon } from '../components/Icon.tsx';
import { ASSETS } from '../assets.ts';

const CATEGORY_LABEL: Record<string, string> = {
  classics_life: '经典与生活',
  ingredients: '认识食材',
  seasonal_living: '四时起居',
};

const TABS = [
  { key: 'recommend', label: '为你推荐' },
  { key: 'classics_life', label: '经典与生活' },
  { key: 'ingredients', label: '认识食材' },
  { key: 'seasonal_living', label: '四时起居' },
] as const;

const KIND_LABEL: Record<string, string> = {
  classic_quote: '经典原文',
  plain_explanation: '白话解释',
  brand_copy: '服务主张',
};

interface Props {
  /** 首次引导模式：显示主张与跳过（H01） */
  intro?: boolean;
  onStart?: () => void;
  onSkip?: () => void;
  onUnauthorized?: () => void;
  onOpenArticle?: (id: string) => void;
}

export function NurturePage({ intro, onStart, onSkip, onUnauthorized, onOpenArticle }: Props) {
  const [manifesto, setManifesto] = useState<Manifesto | null>(null);
  const [articles, setArticles] = useState<ArticleView[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('recommend');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (intro) {
      fetchManifesto()
        .then(setManifesto)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401 && onUnauthorized) onUnauthorized();
          else setError(err instanceof Error ? err.message : '加载失败');
        });
      return;
    }
    fetchArticles()
      .then((result) => setArticles(result.items))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401 && onUnauthorized) onUnauthorized();
        // 无内容不算错误：保留空态（PRD §9：缺少适配内容时允许不推荐）
      });
  }, [intro, onUnauthorized]);

  if (intro) {
    return (
      <div className="page">
        <div className="card">
          <h1 style={{ textAlign: 'center', fontSize: 22 }}>知伴健康</h1>
          {manifesto?.slogans?.length ? (
            <div className="brand" style={{ padding: '10px 0 14px' }}>
              <div className="slogans" aria-label="服务主张">
                {manifesto.slogans.map((slogan) => (
                  <span key={slogan}>{slogan}</span>
                ))}
              </div>
            </div>
          ) : null}
          {error ? (
            <p className="muted">食养主张暂时加载不出来，不影响后面的使用。</p>
          ) : manifesto === null ? (
            <p className="muted" style={{ textAlign: 'center' }}>
              正在加载…
            </p>
          ) : (
            manifesto.sections.map((section, index) => (
              <div
                key={index}
                className={section.kind === 'classic_quote' ? 'classic-block' : 'plain-block'}
              >
                {section.kind === 'classic_quote' ? (
                  <>
                    <blockquote className="classic">{section.text}</blockquote>
                    {section.citation && <p className="citation">出处：{section.citation}</p>}
                  </>
                ) : (
                  <p className={section.kind === 'brand_copy' ? 'brand-copy' : ''}>{section.text}</p>
                )}
                <span className="kind-tag">{KIND_LABEL[section.kind] ?? section.kind}</span>
              </div>
            ))
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={onStart}>
              开始了解我的方案
            </button>
            <button type="button" className="btn btn-ghost" style={{ marginTop: 8 }} onClick={onSkip}>
              先跳过，之后再看
            </button>
          </div>
        </div>
      </div>
    );
  }

  const visible =
    tab === 'recommend' ? articles : articles.filter((item) => item.category === tab);
  const featured = visible[0] ?? null;
  const rest = visible.slice(1);
  const planRelated = articles.find((item) => item.category === 'classics_life') ?? null;

  return (
    <div className="page page-nurture">
      <header className="nurture-head">
        <div className="nurture-brand">
          <Icon name="leaf" size={18} />
          知伴健康
        </div>
        <h1 className="nurture-title">食养</h1>
        <p className="nurture-sub">在日常生活里，读懂照顾自己的智慧。</p>

      </header>

      <nav className="nurture-tabs" aria-label="内容分类">
        {TABS.map((item) => (
          <button
            type="button"
            key={item.key}
            className={`nurture-tab ${tab === item.key ? 'active' : ''}`}
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {featured ? (
        <article
          className="featured-card"
          role="button"
          tabIndex={0}
          onClick={() => onOpenArticle?.(featured.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') onOpenArticle?.(featured.id);
          }}
        >
          <AssetSlot
            id="P06"
            ratio="16 / 10"
            radius={0}
            src={ASSETS.mealSquare}
            label="文章封面"
            className="featured-card__asset"
          />
          <div className="featured-card__body">
            <span className="tag-pill tag-pill--warm">{CATEGORY_LABEL[featured.category]}</span>
            <h2>{featured.title}</h2>
            <p className="featured-card__meta">3 分钟阅读 · 专业审核</p>
          </div>
        </article>
      ) : (
        <section className="card">
          <p className="muted">这一类还没有已发布的内容，换一个分类看看。</p>
        </section>
      )}

      {planRelated && (
        <button type="button" className="plan-link-card">
          <Icon name="bowl" size={30} className="plan-link-card__icon" />
          <span className="plan-link-card__body">
            <span className="plan-link-card__label">与你的计划有关</span>
            <span className="plan-link-card__title">{planRelated.title}</span>
          </span>
          <Icon name="chevron" size={18} className="plan-link-card__arrow" />
        </button>
      )}

      <div className="section-head">
        <h2>慢慢读，慢慢养</h2>
        <AssetSlot id="I05" ratio="6 / 1" radius={0} label="装饰线" className="section-rule" />
      </div>

      <ul className="article-list">
        {rest.length === 0 && <li className="muted article-list__empty">更多内容整理中。</li>}
        {rest.map((item) => (
          <li
            className="article-row"
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpenArticle?.(item.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onOpenArticle?.(item.id);
            }}
          >
            <AssetSlot
              id="P07"
              ratio="1 / 1"
              radius={10}
              src={ASSETS.mealHero}
              label="文章缩略图"
              className="article-row__thumb"
            />
            <div className="article-row__body">
              <span className="tag-pill">{CATEGORY_LABEL[item.category]}</span>
              <p className="article-row__title">{item.title}</p>
              <p className="article-row__summary">{item.summary}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="nurture-footer">好好吃饭，也是照顾自己的开始。</p>
      <div className="footer-space" />
    </div>
  );
}
