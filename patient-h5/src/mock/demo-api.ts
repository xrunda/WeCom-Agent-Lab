/**
 * 演示模式接口实现（VITE_API_MODE=demo）。
 *
 * 只负责把 `demo-data.ts` 的虚构数据拼成契约形状返回，
 * 不含任何业务规则；真实模式下这些接口由 `zhiban-patient-h5` 提供。
 */
import type {
  ArticleView,
  CalendarItemView,
  CalendarView,
  MeResponse,
  PlanView,
  TodayView,
} from '../api.ts';
import {
  DEMO_ARTICLES,
  DEMO_COMPANION_DAYS,
  DEMO_DAILY_TIP,
  DEMO_PLAN,
  demoCalendarItems,
  weekDates,
} from './demo-data.ts';

const personalize = import.meta.env.VITE_DEMO_GREETING === '1';

function greeting(): string {
  const hour = new Date().getHours();
  const base = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  return personalize ? `林女士，${base}` : base;
}

function toView(item: ReturnType<typeof demoCalendarItems>[number]): CalendarItemView {
  return {
    id: item.id,
    title: item.title,
    purpose: item.purpose,
    method: item.method,
    scheduledAt: item.scheduledAt,
    status: item.status,
    feedbackKind: item.feedbackKind,
    overdue: item.overdue,
    cancelReason: item.cancelReason,
  };
}

function articleView(article: (typeof DEMO_ARTICLES)[number]): ArticleView {
  return {
    id: article.id,
    title: article.title,
    summary: article.summary,
    category: article.category,
    publishedAt: article.publishedAt,
  };
}

export function demoMe(): Promise<MeResponse> {
  return Promise.resolve({
    status: 'plan_active',
    reminderEnabled: true,
    serverTime: Date.now(),
    companionDays: DEMO_COMPANION_DAYS,
    profile: { completeness: 1, safetyMissing: false, conflicts: [] },
    plan: {
      planId: DEMO_PLAN.id,
      version: DEMO_PLAN.version,
      status: DEMO_PLAN.status,
      endDate: DEMO_PLAN.endDate,
    },
  });
}

export function demoToday(): Promise<TodayView> {
  const items = demoCalendarItems().map(toView);
  const done = items.filter((item) => item.status === 'done').length;
  const missed = items.filter((item) => item.status === 'missed').length;
  const needsHelp = items.filter((item) => item.status === 'needs_help').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const next = items.find((item) => item.status === 'pending') ?? null;
  return Promise.resolve({
    date: new Date().toISOString().slice(0, 10),
    greeting: greeting(),
    nextItem: next,
    progress: { done, missed, needsHelp, pending, total: items.length },
    quickRecord: { meal: true, review: true },
    relatedArticles: [articleView(DEMO_ARTICLES[0]!), articleView(DEMO_ARTICLES[1]!)],
    allDone: pending === 0 && items.length > 0,
    companionDays: DEMO_COMPANION_DAYS,
  });
}

export function demoCalendar(): Promise<CalendarView> {
  const items = demoCalendarItems().map(toView);
  const days = weekDates().map((date) => ({
    date,
    // 只有今天有完整事项；其余日期给空数组，页面按「暂无安排」渲染
    items: date === new Date().toISOString().slice(0, 10) ? items : [],
  }));
  return Promise.resolve({
    days,
    from: days[0] ? new Date(`${days[0].date}T00:00:00`).getTime() : Date.now(),
    to: Date.now() + 7 * 24 * 60 * 60 * 1000,
    dailyTip: DEMO_DAILY_TIP,
  });
}

export function demoArticles(): Promise<{ items: ArticleView[] }> {
  return Promise.resolve({ items: DEMO_ARTICLES.map(articleView) });
}

export function demoPlan(): Promise<PlanView> {
  return Promise.resolve({
    id: DEMO_PLAN.id,
    version: DEMO_PLAN.version,
    status: DEMO_PLAN.status,
    stageGoal: DEMO_PLAN.stageGoal,
    startDate: DEMO_PLAN.startDate,
    endDate: DEMO_PLAN.endDate,
    foodTherapyRationale: DEMO_PLAN.foodTherapyRationale,
    focusPoints: DEMO_PLAN.focusPoints,
    rationale: DEMO_PLAN.rationale,
    actions: DEMO_PLAN.actions,
    feedbackRequirements: ['每晚回顾睡眠与整体感受'],
    review: DEMO_PLAN.review,
    publishedAt: DEMO_PLAN.publishedAt,
    acknowledgedAt: DEMO_PLAN.acknowledgedAt,
  });
}
