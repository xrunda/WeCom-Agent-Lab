/**
 * 患者端 H5 演示数据（仅 VITE_API_MODE=demo 时启用）。
 *
 * 全部虚构。字段形状严格按 docs/PATIENT-H5-data-model.md 与 api §5–§9，
 * 页面因此可以直接从演示数据切到真实接口，不需要重排布局。
 *
 * 与真实数据的差别写在各处注释里；任何一次演示都必须说明是演示数据。
 */

const DAY = 24 * 60 * 60 * 1000;

/** 以「今天」为基准生成，保证任何时候打开都像当天 */
function atToday(hour: number, minute = 0): number {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

export function localDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** 按时间戳取本地日期（避免用 toISOString 拿到 UTC 日期） */
export function localDateOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** 本周一为起点的日期串（周历用） */
export function weekDates(): string[] {
  const today = new Date();
  const weekday = (today.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, index) => localDate(index - weekday));
}

// ---------- 计划（契约 §3.6：一个版本一条，published） ----------
export const DEMO_PLAN = {
  id: 'hpl_demo_v2',
  version: 2,
  status: 'published',
  stageGoal: '把三餐吃规律，晚餐清淡一点',
  startDate: localDate(-9),
  endDate: localDate(11),
  foodTherapyRationale: '结合你平时偏油的口味，先从「三餐有节、晚餐清淡」开始，不急着一把改完。',
  focusPoints: ['早餐增加一种蔬菜', '三餐按时', '晚餐少油不过饱'],
  actions: [
    {
      actionId: 'act_1',
      title: '早餐记录',
      purpose: '看看早餐吃得够不够丰富',
      method: '拍一张照片，或者用文字记一下吃了什么',
      schedule: { kind: 'daily', time: '07:30' },
      feedbackKind: 'record_meal',
      linkedArticleIds: ['art_demo_breakfast'],
    },
    {
      actionId: 'act_2',
      title: '午餐时光',
      purpose: '按时吃饭，细嚼慢咽',
      method: '到点吃饭，吃完记一句感受',
      schedule: { kind: 'daily', time: '12:00' },
      feedbackKind: 'record_meal',
      linkedArticleIds: [],
    },
    {
      actionId: 'act_3',
      title: '日常活动',
      purpose: '起身动一动，别一坐一整天',
      method: '散步 10 分钟或做几次伸展',
      schedule: { kind: 'daily', time: '16:30' },
      feedbackKind: 'checkin',
      linkedArticleIds: [],
    },
    {
      actionId: 'act_4',
      title: '晚间回顾',
      purpose: '留一分钟，说说今天的感受',
      method: '选一下整体感受、睡眠，可以补充一句',
      schedule: { kind: 'daily', time: '20:30' },
      feedbackKind: 'record_review',
      linkedArticleIds: ['art_demo_sleep'],
    },
  ],
  rationale: {
    basedOn: ['你的目标：改善睡眠', '已确认习惯：22:30 入睡', '已审核食养原则：晚餐七分饱'],
    ruleRefs: [],
  },
  review: { reviewerName: '陈营养师（虚构）', reviewedAt: Date.now() - 9 * DAY },
  publishedAt: Date.now() - 9 * DAY,
  acknowledgedAt: Date.now() - 8 * DAY,
};

// ---------- 今日事项（契约 §3.7） ----------
export interface DemoItem {
  id: string;
  title: string;
  purpose: string;
  method: string;
  scheduledAt: number;
  status: 'pending' | 'done' | 'missed' | 'needs_help' | 'cancelled';
  feedbackKind: 'checkin' | 'record_meal' | 'record_review';
  overdue: boolean;
  cancelReason: string | null;
}

export function demoCalendarItems(): DemoItem[] {
  return [
    {
      id: 'cal_demo_1',
      title: '早餐记录',
      purpose: '看看早餐吃得够不够丰富',
      method: '拍一张照片，或者用文字记一下吃了什么',
      scheduledAt: atToday(7, 30),
      status: 'done',
      feedbackKind: 'record_meal',
      overdue: false,
      cancelReason: null,
    },
    {
      id: 'cal_demo_2',
      title: '午餐时光',
      purpose: '按时吃饭，细嚼慢咽',
      method: '到点吃饭，吃完记一句感受',
      scheduledAt: atToday(12, 0),
      status: 'pending',
      feedbackKind: 'record_meal',
      overdue: false,
      cancelReason: null,
    },
    {
      id: 'cal_demo_3',
      title: '日常活动',
      purpose: '起身动一动，别一坐一整天',
      method: '散步 10 分钟或做几次伸展',
      scheduledAt: atToday(16, 30),
      status: 'pending',
      feedbackKind: 'checkin',
      overdue: false,
      cancelReason: null,
    },
    {
      id: 'cal_demo_4',
      title: '晚间回顾',
      purpose: '留一分钟，说说今天的感受',
      method: '选一下整体感受、睡眠，可以补充一句',
      scheduledAt: atToday(20, 30),
      status: 'pending',
      feedbackKind: 'record_review',
      overdue: false,
      cancelReason: null,
    },
  ];
}

// ---------- 内容（契约 §3.11） ----------
export interface DemoArticle {
  id: string;
  title: string;
  summary: string;
  category: 'classics_life' | 'ingredients' | 'seasonal_living';
  publishedAt: number;
}

export const DEMO_ARTICLES: DemoArticle[] = [
  {
    id: 'art_demo_breakfast',
    title: '早餐，怎样吃得更丰富？',
    summary: '几种家常搭配思路，让早餐更均衡、也更合口味。',
    category: 'classics_life',
    publishedAt: Date.now() - 3 * DAY,
  },
  {
    id: 'art_demo_sleep',
    title: '睡得浅的时候，晚餐可以做点什么',
    summary: '从晚饭的时间和分量说起，聊聊睡前那几小时。',
    category: 'seasonal_living',
    publishedAt: Date.now() - 6 * DAY,
  },
  {
    id: 'art_demo_ingredient',
    title: '认识食材：小米',
    summary: '家常小米的日常吃法、适用条件与注意事项。',
    category: 'ingredients',
    publishedAt: Date.now() - 10 * DAY,
  },
];

/** 今日食养提示（日历页底部卡片） */
export const DEMO_DAILY_TIP = {
  title: '饮食有节，贵在日常',
  text: '今天留意一下：吃饭是否匆忙？',
};

/** 陪伴天数（/me.companionDays；真实接口在 PH5-10 前返回 null） */
export const DEMO_COMPANION_DAYS = 5;
