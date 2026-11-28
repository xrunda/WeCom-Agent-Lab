/**
 * 食养栏目（H08，契约 api §9.2）。
 *
 * 这一页是「每天来坐一会儿」的入口，不是文章库。结构按陪伴流来做：
 *   今日一条（大图 + 听一听 + 今天做的一件小事）
 *   → 按你的情况（按档案匹配，不匹配就整段不出现）
 *   → 慢慢读，慢慢养（分类随手切换，筛选结果就在下方）
 *   → 食养主张（已审核的经典原文）
 *
 * 适老化取舍：
 * - 首屏只推一条，避免老人面对信息流无从下手
 * - 「听一听」用服务端火山 TTS（固定音色）朗读；未配置时按钮不出现，不放无效控件
 * - 每张卡只留一个「今天可以做」的动作，不做多任务
 *
 * 刻意不渲染搜索框：PRD §3.1 把搜索列为增强项，未实现时隐藏。
 * 文章只读已发布内容；停用内容不展示正文（A09）。
 */
import { useEffect, useRef, useState } from 'react';

import { ApiError, fetchArticles, fetchManifesto, fetchProfile } from '../api.ts';
import type { ArticleView, Manifesto, ProfileEntryView } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon } from '../components/Icon.tsx';
import { TabHeader } from '../components/TabHeader.tsx';
import { ASSETS } from '../assets.ts';

const CATEGORY_LABEL: Record<string, string> = {
  classics_life: '经典与生活',
  ingredients: '认识食材',
  seasonal_living: '四时起居',
};

const TABS = [
  { key: 'recommend', label: '全部' },
  { key: 'classics_life', label: '经典与生活' },
  { key: 'ingredients', label: '认识食材' },
  { key: 'seasonal_living', label: '四时起居' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const KIND_LABEL: Record<string, string> = {
  classic_quote: '经典原文',
  plain_explanation: '白话解释',
  brand_copy: '服务主张',
};

/** 档案里的价值词切成关键词，用来匹配文章的场景标签 */
function keywordsOf(entries: ProfileEntryView[]): string[] {
  return entries
    .flatMap((entry) => (entry.valueText ?? '').split(/[、，,；;\s/]+/))
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && word.length <= 8);
}

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
  const [profileEntries, setProfileEntries] = useState<ProfileEntryView[]>([]);
  const [tab, setTab] = useState<TabKey>('recommend');
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = (): void => {
    const current = audioRef.current;
    if (current) {
      current.pause();
      current.src = '';
      audioRef.current = null;
    }
    setSpeaking(null);
  };

  // 主张文案两种模式都要：阅读页底部展示已审核的经典原文
  useEffect(() => {
    fetchManifesto()
      .then(setManifesto)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401 && onUnauthorized) onUnauthorized();
        else if (intro) setError(err instanceof Error ? err.message : '加载失败');
      });
  }, [intro, onUnauthorized]);

  useEffect(() => {
    if (intro) return;
    fetchArticles()
      .then((result) => {
        setArticles(result.items);
        setAudioAvailable(result.audioAvailable);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401 && onUnauthorized) onUnauthorized();
        // 无内容不算错误：保留空态（PRD §9：缺少适配内容时允许不推荐）
      });
    fetchProfile()
      .then((result) => setProfileEntries(result.items))
      .catch(() => {
        // 档案读不到只是「按你的情况」不出现，正文照常可看
      });
  }, [intro, onUnauthorized]);

  // 离开页面时把朗读停掉，避免声音跟着用户走
  useEffect(() => () => stopAudio(), []);

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

  // ---- 今日一条：每天只推一条，其余下沉 ----
  const todayPick = articles[0] ?? null;
  const keywords = keywordsOf(profileEntries);
  const forYou = articles
    .filter((item) => item.id !== todayPick?.id)
    .filter((item) =>
      (item.scenarioTags ?? []).some((tag) =>
        keywords.some((word) => tag.includes(word) || word.includes(tag)),
      ),
    )
    .slice(0, 2);
  const shownIds = new Set<string>(
    [todayPick?.id, ...forYou.map((item) => item.id)].filter((id): id is string => Boolean(id)),
  );
  const rest = articles
    .filter((item) => !shownIds.has(item.id))
    .filter((item) => (tab === 'recommend' ? true : item.category === tab));

  const speak = (item: ArticleView): void => {
    if (!audioAvailable) return;
    if (speaking === item.id) {
      stopAudio();
      return;
    }
    stopAudio();
    setAudioNotice(null);
    const audio = new Audio(`/zhiban/h5/articles/${encodeURIComponent(item.id)}/audio`);
    audio.preload = 'auto';
    audio.onended = () => {
      if (audioRef.current === audio) audioRef.current = null;
      setSpeaking(null);
    };
    const fail = (): void => {
      if (audioRef.current === audio) audioRef.current = null;
      setSpeaking(null);
      setAudioNotice('朗读暂时放不出来，请稍后再试。');
    };
    audio.onerror = fail;
    audioRef.current = audio;
    setSpeaking(item.id);
    void audio.play().catch(fail);
  };

  const card = (item: ArticleView) => {
    const playing = speaking === item.id;
    return (
      // 整卡可点（手指面积大），但键盘与读屏走下面「看全文」实体按钮，
      // 不把 article 声明成 button，避免按钮套按钮
      <article key={item.id} className="feed-card" onClick={() => onOpenArticle?.(item.id)}>
        <AssetSlot
          id="P07"
          ratio="1 / 1"
          radius={10}
          src={item.coverUrl ?? ASSETS.mealHero}
          label="文章配图"
          className="feed-card__thumb"
        />
        <div className="feed-card__body">
          <span className="tag-pill">{CATEGORY_LABEL[item.category]}</span>
          <h3>{item.title}</h3>
          {item.microAction ? (
            <p className="feed-card__action">
              <span className="feed-card__action-lead">今天可以做</span>
              {item.microAction}
            </p>
          ) : (
            <p className="feed-card__summary">{item.summary}</p>
          )}
          <div className="feed-card__row">
            {audioAvailable && (
              <button
                type="button"
                className="feed-card__audio"
                aria-label={playing ? `停止朗读：${item.title}` : `听一听：${item.title}`}
                aria-pressed={playing}
                onClick={(event) => {
                  event.stopPropagation();
                  speak(item);
                }}
              >
                <Icon name={playing ? 'pause' : 'speaker'} size={16} />
                {playing ? '停止' : '听一听'}
              </button>
            )}
            <button
              type="button"
              className="feed-card__more"
              onClick={(event) => {
                event.stopPropagation();
                onOpenArticle?.(item.id);
              }}
            >
              看全文
              <Icon name="arrow" size={14} />
            </button>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="page page-nurture">
      <TabHeader title="食养" size="brand" subtitle="在日常生活里，读懂照顾自己的智慧。" />

      {audioNotice ? (
        <p className="muted" role="status">
          {audioNotice}
        </p>
      ) : null}

      {todayPick ? (
        <section className="feed-section" aria-label="今日一条">
          <div className="feed-section__head">
            <h2>今日一条</h2>
            <span className="muted">每天看一条就够</span>
          </div>
          <article className="feed-card feed-card--lead" onClick={() => onOpenArticle?.(todayPick.id)}>
            <AssetSlot
              id="P06"
              ratio="4 / 3"
              radius={0}
              src={todayPick.coverUrl ?? ASSETS.mealSquare}
              label="今日配图"
              priority
              className="feed-card__cover"
            />
            <div className="feed-card__body">
              <span className="tag-pill">{CATEGORY_LABEL[todayPick.category]}</span>
              <h3>{todayPick.title}</h3>
              <p className="feed-card__summary">{todayPick.summary}</p>
              {todayPick.microAction ? (
                <p className="feed-card__action">
                  <span className="feed-card__action-lead">今天可以做</span>
                  {todayPick.microAction}
                </p>
              ) : null}
              <div className="feed-card__row">
                {audioAvailable && (
                  <button
                    type="button"
                    className="feed-card__audio"
                    aria-label={
                      speaking === todayPick.id
                        ? `停止朗读：${todayPick.title}`
                        : `听一听：${todayPick.title}`
                    }
                    aria-pressed={speaking === todayPick.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      speak(todayPick);
                    }}
                  >
                    <Icon name={speaking === todayPick.id ? 'pause' : 'speaker'} size={16} />
                    {speaking === todayPick.id ? '停止' : '听一听'}
                  </button>
                )}
                <button
                  type="button"
                  className="feed-card__more"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenArticle?.(todayPick.id);
                  }}
                >
                  看全文
                  <Icon name="arrow" size={14} />
                </button>
                <span className="muted feed-card__meta">约 3 分钟</span>
              </div>
            </div>
          </article>
        </section>
      ) : (
        <section className="card">
          <p className="muted">内容正在准备中，稍后再来看看。</p>
        </section>
      )}

      {forYou.length > 0 && (
        <section className="feed-section" aria-label="按你的情况">
          <div className="feed-section__head">
            <h2>按你的情况</h2>
            <span className="muted">看了就能用</span>
          </div>
          {forYou.map(card)}
        </section>
      )}

      <section className="feed-section" aria-label="慢慢读">
        <div className="feed-section__head">
          <h2>慢慢读，慢慢养</h2>
        </div>
        <div className="feed-browse">
          <span className="feed-browse__label">随便看看</span>
          <div className="feed-cats">
            {TABS.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`feed-cat ${tab === item.key ? 'active' : ''}`}
                aria-pressed={tab === item.key}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {rest.length === 0 ? (
          <p className="muted article-list__empty">
            {tab === 'recommend' ? '更多内容整理中。' : '这一类还在整理，先看别的。'}
          </p>
        ) : (
          rest.map(card)
        )}
      </section>

      {manifesto &&
        (() => {
          const quote = manifesto.sections.find((section) => section.kind === 'classic_quote');
          if (!quote) return null;
          return (
            <section className="nurture-creed" aria-label="食养主张">
              <span className="nurture-creed__pill">食养主张</span>
              <p className="nurture-creed__quote">“{quote.text}”</p>
              {quote.citation && <p className="nurture-creed__cite">—— {quote.citation}</p>}
            </section>
          );
        })()}

      <div className="footer-space" />
    </div>
  );
}
