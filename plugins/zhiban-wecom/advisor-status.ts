/**
 * 顾问 1:1 的「我的待办 / 我的草稿」确定性查询。
 *
 * 只回答本人名下的事实：未完成草稿、今日到期承诺、未处理告警。
 * 不带草稿正文、不带客户消息，也不调用模型；数据不齐时如实说没有。
 * 日志由调用方按 userid 尾号记录，本模块不落日志。
 */
import { humanWait } from '../../src/c2/message.ts';
import { shanghaiDayStart } from '../../src/c2/promises.ts';

export interface StatusDraft {
  groupName: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: string;
  /** 进入当前状态的时间，用来算已等多久 */
  since: number;
  version?: number;
}

export interface StatusPromise {
  groupName: string;
  dueAt: number;
  dueLabel: string;
}

export interface StatusAlert {
  /** 已脱敏的告警标题，如「员工发言命中红线」 */
  title: string;
  at: number;
}

export interface AdvisorStatusDeps {
  drafts(advisorId: string): StatusDraft[];
  promises(advisorId: string): StatusPromise[];
  alerts(advisorId: string): StatusAlert[];
  now?: () => number;
}

const TODO_COMMAND = /^(?:(?:我的|今天)\s*)?待办(?:事项)?$/;
const DRAFTS_COMMAND = /^(?:我的\s*)?草稿(?:列表)?$/;

const DRAFT_LIMIT = 5;
const DAY_MS = 24 * 60 * 60_000;

export type AdvisorStatusCommand = 'todo' | 'drafts';

export function isAdvisorStatusCommand(text: string): AdvisorStatusCommand | undefined {
  const trimmed = text.trim();
  if (TODO_COMMAND.test(trimmed)) return 'todo';
  if (DRAFTS_COMMAND.test(trimmed)) return 'drafts';
  return undefined;
}

const RISK_LABELS: Record<StatusDraft['riskLevel'], string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

const DRAFT_STATUS_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  PUSHED: '待确认',
  FAILED: '推送失败',
  UNVERIFIED: '待核验',
  MISROUTE_ALERT: '疑似发错群',
};

/** 仍在顾问手里的草稿；已确认、忽略、已验证、已释放都不算待办 */
const OPEN_DRAFT_STATUSES = new Set(Object.keys(DRAFT_STATUS_LABELS));

export class AdvisorStatusService {
  private readonly deps: AdvisorStatusDeps;

  constructor(deps: AdvisorStatusDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 命中指令时返回回复文本；不是指令返回 undefined，交给改稿流程 */
  reply(advisorId: string, text: string): string | undefined {
    const command = isAdvisorStatusCommand(text);
    if (!command) return undefined;
    const open = this.deps
      .drafts(advisorId)
      .filter((draft) => OPEN_DRAFT_STATUSES.has(draft.status));
    if (command === 'drafts') return this.draftsText(open);
    return this.todoText(advisorId, open);
  }

  private draftsText(drafts: StatusDraft[]): string {
    if (drafts.length === 0) return '你名下没有未完成的草稿。';
    const now = this.now();
    const lines = drafts
      .slice(0, DRAFT_LIMIT)
      .map((draft, index) => {
        const status = DRAFT_STATUS_LABELS[draft.status] ?? draft.status;
        const wait = humanWait(Math.max(0, now - draft.since));
        const version = draft.version && draft.version > 1 ? ` · 第 ${draft.version} 版` : '';
        return `${index + 1}. ${draft.groupName} · ${status} · ${RISK_LABELS[draft.riskLevel]} · 已等 ${wait}${version}`;
      });
    const more = drafts.length > DRAFT_LIMIT ? `\n只列出前 ${DRAFT_LIMIT} 条。` : '';
    return (
      `你名下 ${drafts.length} 条未完成草稿：\n${lines.join('\n')}${more}\n\n` +
      '正文在企微侧边栏查看；收到草稿后直接回复一句话可以改稿。'
    );
  }

  private todoText(advisorId: string, drafts: StatusDraft[]): string {
    const now = this.now();
    const dayStart = shanghaiDayStart(now);
    const dayEnd = dayStart + DAY_MS;
    const promises = this.deps
      .promises(advisorId)
      .filter((promise) => promise.dueAt < dayEnd);
    const alerts = this.deps.alerts(advisorId);
    const total = drafts.length + promises.length + alerts.length;
    if (total === 0) {
      return '现在没有待办：没有未完成草稿、今天没有到期承诺、也没有未处理告警。';
    }

    const facts: string[] = [];
    if (drafts.length > 0) {
      const oldest = Math.min(...drafts.map((draft) => draft.since));
      facts.push(`待处理草稿 ${drafts.length} 条（最久 ${humanWait(Math.max(0, now - oldest))}）`);
    }
    if (promises.length > 0) {
      const next = [...promises].sort((a, b) => a.dueAt - b.dueAt)[0]!;
      facts.push(`今日到期承诺 ${promises.length} 条（最近 ${next.dueLabel}）`);
    }
    if (alerts.length > 0) {
      const latest = [...alerts].sort((a, b) => b.at - a.at)[0]!;
      facts.push(`未处理告警 ${alerts.length} 条（最近：${latest.title}）`);
    }

    return (
      `今天待办：\n· ${facts.join('\n· ')}\n\n` +
      '草稿正文在企微侧边栏查看；告警详情在控制台「质检与告警」。'
    );
  }
}
