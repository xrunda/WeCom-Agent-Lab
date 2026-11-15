/**
 * 顾问 1:1 的「我的待办」确定性命令（#167 §9）。
 *
 * 命令表已收窄：帮助 / 重置对话 / 我的待办 / 纯编号。我的草稿、知识、话术、
 * 为什么红线等关键词路径全部退役为 Agent 工具，这里只保留待办命令。
 * 输出与 `advisor_overview` 工具共用 `src/p1/advisor/format.ts` 的同一个函数，
 * 避免两边数字或措辞不一致。不带草稿正文，不调用模型。
 */
import { buildTodoSnapshot, formatTodoText } from '../../src/p1/advisor/format.ts';
import type { TodoSnapshot } from '../../src/p1/advisor/types.ts';

export interface StatusDraft {
  id: string;
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
  id: string;
  title: string;
  at: number;
}

export interface AdvisorStatusDeps {
  drafts(advisorId: string): StatusDraft[];
  promises(advisorId: string): StatusPromise[];
  alerts(advisorId: string): StatusAlert[];
  /** 待回复会话数；侧边栏未接入时 undefined */
  pendingReplies?(advisorId: string): number | undefined;
  now?: () => number;
}

const TODO_COMMAND = /^(?:(?:我的|今天)\s*)?待办(?:事项)?$/;

export type AdvisorStatusCommand = 'todo';

export function isAdvisorStatusCommand(text: string): AdvisorStatusCommand | undefined {
  const trimmed = text.trim();
  if (TODO_COMMAND.test(trimmed)) return 'todo';
  return undefined;
}

export class AdvisorStatusService {
  private readonly deps: AdvisorStatusDeps;

  constructor(deps: AdvisorStatusDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 命中待办指令时返回回复文本；不是指令返回 undefined */
  reply(advisorId: string, text: string): string | undefined {
    if (isAdvisorStatusCommand(text) !== 'todo') return undefined;
    const snapshot: TodoSnapshot = buildTodoSnapshot({
      drafts: this.deps.drafts(advisorId),
      promises: this.deps.promises(advisorId),
      alerts: this.deps.alerts(advisorId),
      pendingReplies: this.deps.pendingReplies?.(advisorId),
      now: this.now(),
    });
    return formatTodoText(snapshot);
  }
}
