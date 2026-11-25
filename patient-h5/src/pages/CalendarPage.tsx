/**
 * 健康日历（PH5-03 占位骨架；周视图与事项在 PH5-05 落地）。
 * 结构固定：周条 + 每日事项列表占位（展示结构稳定原则）。
 */
import type { MeResponse } from '../api.ts';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function weekDaysOf(today: Date): Date[] {
  const base = new Date(today);
  const weekday = (base.getDay() + 6) % 7; // 周一为 0
  base.setDate(base.getDate() - weekday);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(base);
    day.setDate(base.getDate() + index);
    return day;
  });
}

export function CalendarPage({ me }: { me: MeResponse | null }) {
  const today = new Date();
  const days = weekDaysOf(today);
  const planReady = me?.status === 'plan_active' || me?.status === 'plan_suspended';

  return (
    <div className="page">
      <div className="card">
        <h1 style={{ fontSize: 20 }}>健康日历</h1>
        <div className="week-strip" role="row" aria-label="本周">
          {days.map((day) => {
            const isToday = day.toDateString() === today.toDateString();
            return (
              <div
                key={day.toISOString()}
                className={`week-day ${isToday ? 'today' : ''}`}
                aria-current={isToday ? 'date' : undefined}
              >
                <span className="wd-label">周{WEEKDAYS[(day.getDay() + 6) % 7]}</span>
                <span className="wd-date">{day.getDate()}</span>
              </div>
            );
          })}
        </div>
        <p className="muted">{planReady ? '按日查看你的行动安排。' : '计划发布后，日历会显示每天的行动。'}</p>
      </div>

      <div className="card">
        <h2>今日事项</h2>
        <p className="muted">
          {me?.status === 'plan_generating'
            ? '正在准备计划，事项确定后显示在这里。'
            : '暂无事项；计划发布后按天显示。'}
        </p>
      </div>

      <div className="footer-space" />
    </div>
  );
}
