/**
 * 健康日历（H05，契约 api §6.2）。
 *
 * 结构按概念图：月份与周条 → 问候 → 当日进度 → 事项时间轴（状态与缩略图）
 * → 今日食养提示 → 联系团队。过去/今天/未来按本地日期区分。
 */
import { useEffect, useMemo, useState } from 'react';

import { ApiError, fetchCalendar } from '../api.ts';
import type { CalendarItemView, CalendarView } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

const STATUS_TEXT: Record<string, string> = {
  done: '已完成',
  pending: '待进行',
  missed: '没做到',
  needs_help: '需要帮助',
  cancelled: '已取消',
};

function localDate(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function formatTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  onUnauthorized: () => void;
  onBackToNurture: () => void;
}

export function CalendarPage({ onUnauthorized, onBackToNurture }: Props) {
  const [calendar, setCalendar] = useState<CalendarView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => localDate());

  useEffect(() => {
    fetchCalendar()
      .then((value) => setCalendar(value))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else if (!(err instanceof ApiError && err.status === 403)) {
          setError(err instanceof Error ? err.message : '加载失败');
        }
      });
  }, [onUnauthorized]);

  const today = localDate();
  const days = calendar?.days ?? [];
  const selectedDay = useMemo(
    () => days.find((day) => day.date === selected) ?? null,
    [days, selected],
  );
  const items = selectedDay?.items ?? [];

  const done = items.filter((item) => item.status === 'done').length;
  const total = items.filter((item) => item.status !== 'cancelled').length;
  const monthLabel = `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;

  return (
    <div className="page page-calendar">
      <header className="cal-head">
        <h1>我的健康日历</h1>
        <div className="cal-month">
          <span className="cal-month__nav" aria-hidden="true">‹</span>
          {monthLabel}
          <span className="cal-month__nav" aria-hidden="true">›</span>
        </div>
      </header>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      <div className="week-strip" role="row" aria-label="本周">
        {days.map((day) => {
          const date = new Date(`${day.date}T00:00:00`);
          const isToday = day.date === today;
          const isSelected = day.date === selected;
          return (
            <button
              type="button"
              key={day.date}
              className={`week-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={isSelected}
              onClick={() => setSelected(day.date)}
            >
              <span className="wd-label">{WEEK_LABEL[(date.getDay() + 6) % 7]}</span>
              <span className="wd-date">{date.getDate()}</span>
            </button>
          );
        })}
      </div>

      <section className="cal-greeting">
        <h2>{selected === today ? '今天' : `${selected.slice(5).replace('-', '月')}日`}</h2>
        <p className="muted">按时完成每一项，比一次做很多更重要。</p>
      </section>

      {total > 0 && (
        <div className="progress-pill">
          <span>
            今日安排 {done} / {total} 已完成
          </span>
          <span className="progress-pill__bar" aria-hidden="true">
            <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
        </div>
      )}

      <ol className="timeline timeline--rich">
        {items.length === 0 && <li className="timeline__empty muted">这一天还没有安排</li>}
        {items.map((item: CalendarItemView) => (
          <li className="timeline__row timeline__row--rich" key={item.id}>
            <span className={`timeline__dot timeline__dot--${item.status}`} aria-hidden="true" />
            <span className="timeline__time">{formatTime(item.scheduledAt)}</span>
            <span className="timeline__body">
              <span className="timeline__title">{item.title}</span>
              <span className="timeline__purpose">{item.method ?? item.purpose}</span>
              <span className={`chip chip--${item.status}`}>
                {STATUS_TEXT[item.status] ?? item.status}
              </span>
            </span>
            {item.feedbackKind === 'record_meal' && item.status === 'done' && (
              <AssetSlot id="D01" ratio="4 / 3" radius={8} label="餐食记录缩略图" className="timeline__thumb" />
            )}
          </li>
        ))}
      </ol>

      {calendar?.dailyTip && (
        <section className="tip-card">
          <div className="tip-card__body">
            <span className="tag-pill tag-pill--solid">今日食养提示</span>
            <h2>{calendar.dailyTip.title}</h2>
            <p className="muted">{calendar.dailyTip.text}</p>
            <button type="button" className="link-btn" onClick={onBackToNurture}>
              了解这条安排的食养思路 →
            </button>
          </div>
          <AssetSlot id="I01" ratio="1 / 1" radius={10} label="植物插画" className="tip-card__asset" />
        </section>
      )}

      <div className="team-line">
        <button type="button" className="link-btn">
          联系专业团队 →
        </button>
      </div>

      <div className="footer-space" />
    </div>
  );
}
