/**
 * 今天首页（H03，契约 api §6.1）。
 *
 * 区块顺序按概念图：日期 → 问候 → 陪伴与今日食养 → 下一件小事 →
 * 今天的节奏 → 快捷记录 → 相关食养 → 你的团队。
 *
 * 数据来自 /today；无计划时退回状态提示（PRD H03「无计划显示准备中」）。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchMe, fetchToday } from '../api.ts';
import type { CalendarItemView, TodayView } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon } from '../components/Icon.tsx';
import { ASSETS } from '../assets.ts';
import { RecordSheet } from '../components/RecordSheet.tsx';
import { TabHeader } from '../components/TabHeader.tsx';

const STATUS_TEXT: Record<string, string> = {
  done: '已完成',
  pending: '待进行',
  missed: '没做到',
  needs_help: '需要帮助',
  cancelled: '已取消',
};

function formatTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  /** 无计划/准备中等状态的提示（来自 /me） */
  statusHint: { title: string; text: string } | null;
  /** 未完成建档时的主行动 */
  needOnboarding: boolean;
  onStartOnboarding: () => void;
  onOpenCalendar: () => void;
  onOpenNurture: () => void;
  onOpenTeam: () => void;
  onUnauthorized: () => void;
}

export function TodayPage({
  statusHint,
  needOnboarding,
  onStartOnboarding,
  onOpenCalendar,
  onOpenNurture,
  onOpenTeam,
  onUnauthorized,
}: Props) {
  const [today, setToday] = useState<TodayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'meal' | 'review' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [patientName, setPatientName] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then((me) => setPatientName(me.displayName ?? null))
      .catch(() => undefined);
    fetchToday()
      .then(setToday)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else if (!(err instanceof ApiError && err.status === 403)) {
          setError(err instanceof Error ? err.message : '加载失败');
        }
      });
  }, [onUnauthorized]);

  const greeting = today?.greeting ?? '你好';
  const progress = today?.progress;
  const next = today?.nextItem;

  return (
    <div className="page page-today">
      <TabHeader
        title={`${patientName ? `${patientName}，` : ''}${greeting}。`}
        subtitle="把今天照顾好，健康慢慢来。"
      />

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      {statusHint && (
        <section className="card">
          <h2>{statusHint.title}</h2>
          <p className="muted">{statusHint.text}</p>
          {needOnboarding && (
            <button type="button" className="btn btn-primary" onClick={onStartOnboarding}>
              开始建档
            </button>
          )}
        </section>
      )}

      {today && (
        <>
          <section className="hero-card">
            <AssetSlot
              id="P02"
              ratio="4 / 3"
              radius={0}
              src={ASSETS.mealHero}
              priority
              label="今日餐食配图"
              className="hero-card__asset"
            />
            <div className="hero-card__body">
              <p className="hero-card__label">
                陪伴你的第 <b>{today.companionDays ?? '—'}</b> 天
              </p>
              <p className="hero-card__title">今日食养</p>
              <p className="hero-card__meta">
                已完成 <b>{progress?.done ?? 0}</b> 项，还有{' '}
                <b>{progress?.pending ?? 0}</b> 项
              </p>
            </div>
          </section>

          {next ? (
            <section className="next-card">
              <span className="next-card__badge">下一件小事</span>
              <div className="next-card__main">
                <Icon name="bowl" size={30} className="next-card__icon" />
                <div className="next-card__text">
                  <p className="next-card__time">
                    {formatTime(next.scheduledAt)} {next.title}
                  </p>
                  <p className="next-card__purpose">{next.purpose}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-inline next-card__cta"
                  onClick={onOpenCalendar}
                >
                  <Icon name="camera" size={18} />
                  {next.feedbackKind === 'record_review' ? '记录感受' : '记录这一餐'}
                </button>
              </div>
            </section>
          ) : (
            <section className="card">
              <h2>{today.allDone ? '今天都完成了' : '今天没有安排'}</h2>
              <p className="muted">
                {today.allDone
                  ? '做到这些已经很好了，早点休息。'
                  : '计划发布后，这里显示今天要做的事。'}
              </p>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2>今天的健康节奏</h2>
              <button type="button" className="link-btn" onClick={onOpenCalendar}>
                完整日历 →
              </button>
            </div>
            <ol className="timeline">
              <TimelineRows today={today} />
            </ol>
          </section>

          <section className="quick-row">
            <button
              type="button"
              className="quick-card"
              disabled={!today.quickRecord.meal}
              onClick={() => setSheet('meal')}
            >
              <Icon name="camera" size={30} className="quick-card__icon" />
              <span className="quick-card__body">
                <span className="quick-card__title">拍照记餐</span>
                <span className="quick-card__hint">记录三餐，更了解自己。</span>
              </span>
              <Icon name="chevron" size={16} className="quick-card__arrow" />
            </button>
            <button
              type="button"
              className="quick-card quick-card--warm"
              disabled={!today.quickRecord.review}
              onClick={() => setSheet('review')}
            >
              <Icon name="chat" size={30} className="quick-card__icon" />
              <span className="quick-card__body">
                <span className="quick-card__title">说说身体感受</span>
                <span className="quick-card__hint">今天的精神、胃口、睡眠等。</span>
              </span>
              <Icon name="chevron" size={16} className="quick-card__arrow" />
            </button>
          </section>

          {today.relatedArticles.length > 0 && (
            <section className="article-card">
              <div className="article-card__body">
                <span className="tag-pill">与你的计划有关</span>
                <h2>{today.relatedArticles[0]!.title}</h2>
                <p className="muted">{today.relatedArticles[0]!.summary}</p>
                <button type="button" className="link-btn" onClick={onOpenNurture}>
                  食养阅读 →
                </button>
              </div>
              <AssetSlot
                id="P03"
                ratio="1 / 1"
                radius={10}
                src={ASSETS.mealSquare}
                label="文章缩略图"
                className="article-card__asset"
              />
            </section>
          )}

          <section className="team-card">
            <div className="team-card__body">
              <p className="team-card__title">专业团队一直在这里</p>
              <p className="muted">有疑问、想沟通，随时联系。</p>
            </div>
            <button type="button" className="btn btn-secondary btn-inline" onClick={onOpenTeam}>
              联系团队
            </button>
          </section>
        </>
      )}

      {notice && (
        <div className="notice notice-ok" role="status">
          {notice}
        </div>
      )}

      {sheet && (
        <RecordSheet
          mode={sheet}
          defaultMealType={defaultMealType()}
          {...(today?.nextItem && today.nextItem.feedbackKind !== 'checkin'
            ? { linkedCalendarItemId: today.nextItem.id }
            : {})}
          onClose={() => setSheet(null)}
          onSaved={(message) => {
            setNotice(message);
            void fetchToday().then(setToday).catch(() => undefined);
          }}
        />
      )}

      <div className="footer-space" />
    </div>
  );
}

/** 按当前时间猜一个餐次，患者可改 */
function defaultMealType(): 'breakfast' | 'lunch' | 'dinner' | 'snack' {
  const hour = new Date().getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

/** 时间轴行：今日全部事项（按时间升序，与设计稿一致） */
function TimelineRows({ today }: { today: TodayView }) {
  const list: CalendarItemView[] = today.items ?? (today.nextItem ? [today.nextItem] : []);
  return (
    <>
      {list.map((item) => (
        <li className="timeline__row" key={item.id}>
          <span className={`timeline__dot timeline__dot--${item.status}`} aria-hidden="true" />
          <span className="timeline__time">{formatTime(item.scheduledAt)}</span>
          <span className="timeline__body">
            <span className="timeline__title">{item.title}</span>
            <span className="timeline__purpose">{item.purpose}</span>
          </span>
          {item.status !== 'pending' && (
            <span className={`chip chip--${item.status}`}>
              {STATUS_TEXT[item.status] ?? item.status}
            </span>
          )}
        </li>
      ))}
    </>
  );
}
