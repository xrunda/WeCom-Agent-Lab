/**
 * 顾问 1:1 的精确命令表（#167 §9）。
 *
 * 闭集、只允许变短，不因识别失败加词：知识 / 话术 / 为什么红线 / 我的草稿
 * 全部退役为 Agent 工具，命令只保留「帮助 / 重置对话 / 我的待办 / 纯编号」。
 * 问法变化由 Agent 承担，命令不做「包含关键词」，不猜意图。
 */

/** 纯编号选择：上一条列表的第 N 条；只认 1–9，避免劫持普通对话 */
export function selectionNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[1-9]$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

const HELP_RE = /^(帮助|指令|能做什么)\s*$/;

export function isHelpCommand(text: string): boolean {
  return HELP_RE.test(text.trim());
}

export function isResetCommand(text: string): boolean {
  return text.trim() === '重置对话';
}

/** 帮助文案：只列仍在命令表里的动作，不列已退役的关键词 */
export const ADVISOR_HELP_TEXT =
  '可用指令：\n' +
  '· 帮助 —— 查看可用指令\n' +
  '· 我的待办 / 今天待办 —— 未完成草稿、今日到期承诺、未处理告警\n' +
  '· 重置对话 —— 清空上下文，重新开始\n' +
  '· 回复列表里的编号（1–9）—— 查看上一条列表的对应条目\n\n' +
  '其他问题直接用一句话问就行，比如「汪女士最近血糖怎么样」「降压药的话术再发我一遍」。\n\n' +
  '机器人只回复你本人，不会向客户群发送任何内容。';
