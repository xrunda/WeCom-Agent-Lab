/**
 * 顾问 1:1 单聊文本的路由决策（#167 §9）。
 *
 * 命令表闭集：帮助 / 重置对话 / 我的待办 / 纯编号。其余全部交给
 * zhibanAdvisor；Agent 不可用时回到旧路径（有活动草稿当改稿，否则用法提示）。
 * 知识 / 话术 / 为什么红线 / 我的草稿关键词路径已退役，不再在这里判断。
 */
import {
  ADVISOR_HELP_TEXT,
  isHelpCommand,
  isResetCommand,
  selectionNumber,
} from '../../src/p1/advisor/commands.ts';

export type RouteAction =
  | { kind: 'reply'; text: string }
  | { kind: 'reset' }
  | { kind: 'selection'; number: number }
  | { kind: 'agent'; text: string }
  | { kind: 'fallback' };

export interface RouteInput {
  text: string;
  /** 已解析的顾问 id；未知用户为空 */
  advisorId?: string;
  /** zhibanAdvisor 已安装且 enabled */
  advisorAvailable: boolean;
  /** 待办命令的回复；不是待办命令时返回 undefined */
  todoReply(advisorId: string): string | undefined;
}

const RESET_UNAVAILABLE = '「重置对话」需要在机器人 Agent 可用时使用，请稍后再试。';
const SELECTION_UNAVAILABLE = '机器人暂时无法处理编号选择，请直接说一句要查的内容。';

export function routeSingleText(input: RouteInput): RouteAction {
  const trimmed = input.text.trim();

  if (isHelpCommand(trimmed)) {
    return { kind: 'reply', text: ADVISOR_HELP_TEXT };
  }

  if (input.advisorId !== undefined && input.advisorId !== '') {
    const todo = input.todoReply(input.advisorId);
    if (todo !== undefined) return { kind: 'reply', text: todo };
  }

  if (isResetCommand(trimmed)) {
    if (input.advisorAvailable && input.advisorId) return { kind: 'reset' };
    return { kind: 'reply', text: RESET_UNAVAILABLE };
  }

  const selection = selectionNumber(trimmed);
  if (selection !== undefined) {
    if (input.advisorAvailable && input.advisorId) {
      return { kind: 'selection', number: selection };
    }
    return { kind: 'reply', text: SELECTION_UNAVAILABLE };
  }

  if (input.advisorAvailable && input.advisorId) {
    return { kind: 'agent', text: input.text };
  }
  return { kind: 'fallback' };
}
