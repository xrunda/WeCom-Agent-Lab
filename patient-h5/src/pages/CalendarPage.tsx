/**
 * 健康日历（H05，契约 api §6.2），按设计稿 ui-03 还原：
 * 大标题 → 月份 → 周条 → 问候（竖线强调）→ 进度条 →
 * 带圆形图标的时间轴（右侧为缩略图 / 记录按钮 / 箭头）→ 今日食养提示 → 联系团队。
 */
import { useEffect, useMemo, useState } from 'react';

import { ApiError, fetchCalendar, fetchMe, submitItemFeedback, type CalendarItemView, type CalendarView } from '../api.ts';
import { ASSETS } from '../assets.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { RecordSheet } from '../components/RecordSheet.tsx';
import { Sheet } from '../components/Sheet.tsx';

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

const STATUS_TEXT: Record<string, string> = {
  done: '已完成',
  pending: '待记录',
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

function iconFor(item: CalendarItemView): IconName {
  if (item.feedbackKind === 'record_meal') return 'bowl';
  if (item.feedbackKind === 'record_review') return 'moon';
  return 'run';
}

function greetingOf(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

interface Props {
  onUnauthorized: () => void;
  onBackToNurture: () => void;
  onOpenTeam: () => void;
}

export function CalendarPage({ onUnauthorized, onBackToNurture, onOpenTeam }: Props) {
  const [calendar, setCalendar] = useState<CalendarView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => localDate());
  const [detail, setDetail] = useState<CalendarItemView | null>(null);
  const [recordItem, setRecordItem] = useState<CalendarItemView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [patientName, setPatientName] = useState<string | null>(null);

  const load = (): void => {
    fetchCalendar()
      .then(setCalendar)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else if (!(err instanceof ApiError && err.status === 403)) {
          setError(err instanceof Error ? err.message : '加载失败');
        }
      });
  };

  useEffect(() => {
    load();
    fetchMe()
      .then((me) => setPatientName(me.displayName ?? null))
      .catch(() => undefined);
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

  const send = async (
    item: CalendarItemView,
    kind: 'patient_confirmed' | 'missed' | 'needs_help',
  ): Promise<void> => {
    setBusy(true);
    try {
      const updated = await submitItemFeedback({ itemId: item.id, kind });
      setDetail(updated);
      setNotice(kind === 'needs_help' ? '已告诉团队，会有人跟进' : '已记录');
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '提交失败，请重试');
    } finally {
      setBusy(false);
    }
  };

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
        <h2>
          <span className="accent-bar" aria-hidden="true" />
          {patientName ? `${patientName}，` : ''}
          {selected === today ? greetingOf() : `${selected.slice(5).replace('-', '月')}日`}
        </h2>
        <p className="muted">今天，从一顿从容的早餐开始。</p>
      </section>

      {total > 0 && (
        <div className="progress-pill">
          <span>
            今日食养 {done} / {total} 已完成
          </span>
          <span className="progress-pill__bar" aria-hidden="true">
            <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
        </div>
      )}

      <ol className="timeline timeline--rich">
        {items.length === 0 && <li className="timeline__empty muted">这一天还没有安排</li>}
        {items.map((item) => {
          const showRecordButton =
            item.canFeedback && item.feedbackKind === 'record_meal' && item.status === 'pending';
          return (
            <li className="timeline__row timeline__row--rich" key={item.id}>
              <span className={`timeline__bubble timeline__bubble--${item.status}`}>
                <Icon name={iconFor(item)} size={20} />
              </span>
              <span className="timeline__time">{formatTime(item.scheduledAt)}</span>
              <button
                type="button"
                className="timeline__body timeline__body--button"
                onClick={() => setDetail(item)}
              >
                <span className="timeline__title">{item.title}</span>
                {item.method || item.purpose ? (
                  <span className="timeline__purpose">{item.method ?? item.purpose}</span>
                ) : null}
                {item.status !== 'pending' && (
                  <span className={`chip chip--${item.status}`}>
                    {STATUS_TEXT[item.status] ?? item.status}
                  </span>
                )}
              </button>
              {item.feedbackKind === 'record_meal' && item.status === 'done' ? (
                <AssetSlot
                  id="D01"
                  ratio="4 / 3"
                  radius={8}
                  src={ASSETS.mealHero}
                  label="餐食记录缩略图"
                  className="timeline__thumb"
                />
              ) : showRecordButton ? (
                <button
                  type="button"
                  className="btn btn-primary btn-inline timeline__cta"
                  onClick={() => setRecordItem(item)}
                >
                  记录这一餐
                  <Icon name="chevron" size={14} />
                </button>
              ) : (
                <Icon name="chevron" size={16} className="timeline__arrow" />
              )}
            </li>
          );
        })}
      </ol>

      {calendar?.dailyTip && (
        <section className="tip-card">
          <div className="tip-card__body">
            <span className="tip-card__pill">今日食养提示</span>
            <h2>{calendar.dailyTip.title}</h2>
            <p className="tip-card__text">{calendar.dailyTip.text}</p>
            <button type="button" className="link-btn tip-card__link" onClick={onBackToNurture}>
              了解这条安排的食养思路 →
            </button>
          </div>
          <AssetSlot
            id="I01"
            ratio="1 / 1"
            radius={12}
            src={ASSETS.mealSquare}
            label="食养配图"
            className="tip-card__asset"
          />
        </section>
      )}

      <div className="team-line">
        <button type="button" className="link-btn team-line__btn" onClick={onOpenTeam}>
          <Icon name="headset" size={20} />
          联系专业团队
          <Icon name="chevron" size={14} />
        </button>
      </div>

      {notice && (
        <div className="notice notice-ok" role="status">
          {notice}
        </div>
      )}

      {detail && (
        <Sheet open onClose={() => setDetail(null)} label="事项详情">
            <h2>{detail.title}</h2>
            <p className="muted">{detail.purpose}</p>
            {detail.method && <p className="sheet__method">{detail.method}</p>}
            <p className="muted">
              {formatTime(detail.scheduledAt)} · {STATUS_TEXT[detail.status] ?? detail.status}
              {detail.overdue ? ' · 待跟进' : ''}
            </p>
            {detail.canFeedback ? (
              <div className="sheet__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void send(detail, 'patient_confirmed')}
                >
                  我完成了
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void send(detail, 'missed')}
                >
                  今天没做到
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void send(detail, 'needs_help')}
                >
                  需要帮助
                </button>
              </div>
            ) : (
              <p className="muted">
                {detail.status === 'cancelled'
                  ? '这一项已被取消，不能再反馈。'
                  : (detail.scheduledDate ?? '') > localDate()
                    ? '还没到这一天，暂时不能确认。'
                    : '这一项已经反馈过了。'}
              </p>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setDetail(null)}>
              关闭
            </button>
        </Sheet>
      )}

      {recordItem && (
        <RecordSheet
          mode="meal"
          defaultMealType="lunch"
          linkedCalendarItemId={recordItem.id}
          onClose={() => setRecordItem(null)}
          onSaved={(message) => {
            setNotice(message);
            setRecordItem(null);
            load();
          }}
        />
      )}

      <div className="footer-space" />
    </div>
  );
}
