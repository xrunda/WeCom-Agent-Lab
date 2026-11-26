/**
 * 健康日历（H05，契约 api §6.2），按设计稿 ui-03 还原：
 * 大标题 → 月份 → 周条 → 问候（竖线强调）→ 进度条 →
 * 带圆形图标的时间轴（右侧为缩略图 / 记录按钮 / 箭头）→ 今日食养提示 → 联系团队。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, fetchCalendar, fetchMe, submitItemFeedback, type CalendarItemView, type CalendarView } from '../api.ts';
import { ASSETS } from '../assets.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { RecordSheet } from '../components/RecordSheet.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { TabHeader } from '../components/TabHeader.tsx';
import { almanacLine, almanacOf } from '../utils/almanac.ts';
import { lunarDayOf } from '../utils/lunar.ts';
import { nextSolarTerm, solarTermOn } from '../utils/solar-terms.ts';
import { addMemo, loadMemos, MEMO_LABELS, memosPersistent, memosOn, removeMemo } from '../utils/memos.ts';
import type { Memo, MemoType } from '../utils/memos.ts';

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
  /** week：一周条；month：整月展开 */
  const [expanded, setExpanded] = useState(false);
  const [memos, setMemos] = useState<Memo[]>(() => loadMemos());
  const [memoDate, setMemoDate] = useState<string | null>(null);
  const [memoType, setMemoType] = useState<MemoType>('birthday');
  const [memoTitle, setMemoTitle] = useState('');

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
  const monthLabel = `${Number(selected.slice(0, 4))}年${Number(selected.slice(5, 7))}月`;
  const nextTerm = useMemo(() => nextSolarTerm(today), [today]);

  /** 切换月份：保留「日」，超出该月天数时取月末 */
  const shiftMonth = (delta: number): void => {
    const [yearText, monthText, dayText] = selected.split('-');
    const year = Number(yearText);
    const month = Number(monthText) - 1 + delta;
    const target = new Date(year, month, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    const day = Math.min(Number(dayText), lastDay);
    setSelected(
      `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    );
  };

  /** 月网格：周一起，固定 6 行，含上下月补位 */
  const monthCells = useMemo(() => {
    const year = Number(selected.slice(0, 4));
    const month = Number(selected.slice(5, 7)) - 1;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`;
      return { date: key, inMonth: date.getMonth() === month, day: date.getDate() };
    });
  }, [selected]);

  const dayMemos = memosOn(memos, selected);

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
      <TabHeader eyebrow={almanacLine(almanacOf())} title="我的健康日历" />

      <div className="cal-month">
        <button
          type="button"
          className="cal-month__nav"
          aria-label="上个月"
          onClick={() => shiftMonth(-1)}
        >
          ‹
        </button>
        {monthLabel}
        <button
          type="button"
          className="cal-month__nav"
          aria-label="下个月"
          onClick={() => shiftMonth(1)}
        >
          ›
        </button>
        <button
          type="button"
          className="cal-month__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开月历'}
        </button>
      </div>

      <section className="term-next" aria-label="下一个节气">
        <span className="term-next__bar" aria-hidden="true" />
        <span className="term-next__name">{nextTerm.name}</span>
        <span className="term-next__rule" aria-hidden="true" />
        <span className="term-next__count">
          {nextTerm.days === 0 ? (
            <span className="term-next__today">就在今天</span>
          ) : (
            <>
              <span className="term-next__lead">还有</span>
              <span className="term-next__num">{nextTerm.days}</span>
              <span className="term-next__unit">天</span>
            </>
          )}
        </span>
        <span className="term-next__date">{nextTerm.date.slice(5).replace('-', '月')}日</span>
      </section>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      {expanded ? (
        <div className="month-grid" role="grid" aria-label="本月日历">
          {WEEK_LABEL.map((label) => (
            <span className="month-grid__weekday" key={label} role="columnheader">
              {label}
            </span>
          ))}
          {monthCells.map((cell) => (
            <DayCell
              key={cell.date}
              cell={cell}
              today={today}
              selected={selected}
              memos={memos}
              onSelect={() => setSelected(cell.date)}
              onLongPress={() => {
                setMemoDate(cell.date);
                setSelected(cell.date);
              }}
            />
          ))}
        </div>
      ) : (
        <div className="week-strip" role="row" aria-label="本周">
          {days.map((day) => {
            const date = new Date(`${day.date}T00:00:00`);
            return (
              <button
                type="button"
                key={day.date}
                className={`week-day ${day.date === today ? 'today' : ''} ${day.date === selected ? 'selected' : ''}`}
                aria-current={day.date === today ? 'date' : undefined}
                aria-pressed={day.date === selected}
                onClick={() => setSelected(day.date)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMemoDate(day.date);
                  setSelected(day.date);
                }}
              >
                <span className="wd-label">{WEEK_LABEL[(date.getDay() + 6) % 7]}</span>
                <span className="wd-date">{date.getDate()}</span>
                <span className="wd-lunar">{cellLabel(day.date)}</span>
              </button>
            );
          })}
        </div>
      )}

      <section className="cal-greeting">
        <h2>
          <span className="accent-bar" aria-hidden="true" />
          {patientName ? `${patientName}，` : ''}
          {selected === today
            ? greetingOf()
            : `${Number(selected.slice(5, 7))}月${Number(selected.slice(8, 10))}日`}
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

      {(
        <section className="memo-block">
          <div className="memo-block__head">
            <span className="memo-block__title">这一天的备忘</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMemoDate(selected);
                setMemoTitle('');
              }}
            >
              ＋ 添加备忘
            </button>
          </div>
          {dayMemos.length === 0 ? (
            <p className="muted memo-block__empty">
              长按日历上的日期，可以记生日、纪念日或复查安排。
            </p>
          ) : (
            <ul className="memo-list">
              {dayMemos.map((memo) => (
                <li className="memo-item" key={memo.id}>
                  <span className="memo-item__type">{MEMO_LABELS[memo.type]}</span>
                  <span className="memo-item__title">{memo.title}</span>
                  <button
                    type="button"
                    className="link-btn memo-item__remove"
                    onClick={() => {
                      removeMemo(memo.id);
                      setMemos(loadMemos());
                    }}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
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

      {memoDate && (
        <Sheet open onClose={() => setMemoDate(null)} label="添加备忘">
          <h2>记一件重要的事</h2>
          <p className="muted">{memoDate.replace(/-/g, '/')}</p>
          <div className="sheet__row">
            {(Object.keys(MEMO_LABELS) as MemoType[]).map((type) => (
              <button
                key={type}
                type="button"
                className={`btn btn-inline ${memoType === type ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={memoType === type}
                onClick={() => setMemoType(type)}
              >
                {MEMO_LABELS[type]}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="memo-title">写一句提醒自己的话</label>
            <input
              id="memo-title"
              value={memoTitle}
              onChange={(event) => setMemoTitle(event.target.value)}
              placeholder="例如：母亲生日，记得打电话"
              maxLength={30}
            />
          </div>
          {!memosPersistent() && (
            <p className="muted">本机存储不可用，关闭页面后备忘会丢失。</p>
          )}
          <div className="sheet__actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!memoTitle.trim()}
              onClick={() => {
                addMemo({ date: memoDate, type: memoType, title: memoTitle });
                setMemos(loadMemos());
                setMemoDate(null);
                setMemoTitle('');
                setNotice('已记下这一天');
              }}
            >
              保存备忘
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMemoDate(null)}>
              关闭
            </button>
          </div>
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

/** 格子里的农历/节气短标签 */
function cellLabel(date: string): string {
  return solarTermOn(date) ?? lunarDayOf(date).label ?? '';
}

/**
 * 月历格子。长按 600ms 记备忘；轻点选中。
 * 同时支持右键（桌面）作为长按的等价操作，方便调试与无触屏环境。
 */
function DayCell({
  cell,
  today,
  selected,
  memos,
  onSelect,
  onLongPress,
}: {
  cell: { date: string; inMonth: boolean; day: number };
  today: string;
  selected: string;
  memos: Memo[];
  onSelect: () => void;
  onLongPress: () => void;
}) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);

  const clear = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const start = (): void => {
    fired.current = false;
    clear();
    timer.current = window.setTimeout(() => {
      fired.current = true;
      onLongPress();
    }, 600);
  };

  const hasMemo = memosOn(memos, cell.date).length > 0;
  const term = solarTermOn(cell.date);
  const label = term ?? lunarDayOf(cell.date).label ?? '';

  return (
    <button
      type="button"
      role="gridcell"
      className={[
        'day-cell',
        cell.inMonth ? '' : 'day-cell--outside',
        cell.date === today ? 'day-cell--today' : '',
        cell.date === selected ? 'day-cell--selected' : '',
        term ? 'day-cell--term' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-current={cell.date === today ? 'date' : undefined}
      aria-label={`${cell.date}${label ? ` ${label}` : ''}${hasMemo ? ' 有备忘' : ''}`}
      onPointerDown={start}
      onPointerUp={clear}
      onPointerLeave={clear}
      onContextMenu={(event) => {
        event.preventDefault();
        onLongPress();
      }}
      onClick={() => {
        if (fired.current) {
          fired.current = false;
          return;
        }
        onSelect();
      }}
    >
      <span className="day-cell__solar">{cell.day}</span>
      <span className="day-cell__lunar">{label}</span>
      {hasMemo && <span className="day-cell__memo" aria-hidden="true" />}
    </button>
  );
}
