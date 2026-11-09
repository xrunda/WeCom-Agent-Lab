/**
 * #34 人设与回合输入；#63 发言人身份 / 角色；#56 改稿指令。
 *
 * 提示词一律由租户设置生成，不在代码里写死机构名；
 * 红线条款每次回合都带上，不能靠模型记性。
 */
import type { InboundMessage, MergedInbound, Speaker, TenantAgentSettings } from './types.ts';

export const RED_LINES = [
  '不做诊断、不调整药物剂量、不承诺疗效；涉及用药与检查结论时，只建议咨询医生。',
  '出现胸痛、呼吸困难、意识改变、大出血等急症描述时，立即建议拨打 120 或去急诊，不继续给生活建议。',
  '你产出的只是草稿，必须由顾问确认后才会发出；不要写成「我已经帮你安排好了」。',
  '家属或角色未知的成员发言，不能当作患者本人的事实；引用时要写明「家属说」「群里有人提到」。',
  '不输出其他患者、其他群成员的个人信息；不猜测未提供的隐私。',
  '未同意会话存档的成员，其内容不进入自动服务；只提示顾问人工跟进。',
];

export function buildSystemPrompt(settings: TenantAgentSettings): string {
  return [
    `你是「${settings.agentName}」，${settings.advisorName} 团队的健康助理。`,
    `服务对象统一称呼为「${settings.patientTerm}」。语气：${settings.tone}。`,
    '你的回复不会直接发给患者，而是作为草稿交给顾问审核后发出。',
    '',
    '【红线】',
    ...RED_LINES.map((line, index) => `${index + 1}. ${line}`),
    '',
    '【工具约定】',
    '- 每一轮都必须调用 reply_draft 提交草稿；不要用普通文本回复代替。',
    '- 如果这一轮不需要回复（例如只是内部同事寒暄、或信息不足且不适合回复），调用 reply_skip 并写明原因。',
    '- 草稿正文只包含要发给患者的话，不写「草稿」「请审核」等内部说明。',
  ].join('\n');
}

const ROLE_LABEL: Record<Speaker['role'], string> = {
  self: '本人',
  family: '家属',
  advisor: '顾问',
  colleague: '同事',
  unknown: '身份未知',
};

export function speakerLabel(speaker: Speaker): string {
  return `${speaker.displayName}（${ROLE_LABEL[speaker.role]}${speaker.isExternal ? '，外部成员' : '，内部员工'}）`;
}

export function formatMessage(message: InboundMessage): string {
  const time = new Date(message.msgtime).toISOString().slice(11, 16);
  if (message.msgtype === 'image') {
    return `- ${time} [图片] ${message.mediaPath ?? '（原图未落盘）'}`;
  }
  return `- ${time} ${message.text}`;
}

export interface TurnPromptOptions {
  /** #56：顾问的改稿指令 */
  revisionInstruction?: string;
  /** #63：近期内部员工发言，作为上下文 */
  groupContext?: Array<{ speaker: Speaker; text: string; at: number }>;
  /** 主动触发的回合（#36 会用到） */
  proactive?: { reason: string };
  /** 当前草稿版本；改稿时告知模型这是第几版 */
  currentVersion?: number;
}

export function buildTurnPrompt(
  merged: MergedInbound,
  settings: TenantAgentSettings,
  options: TurnPromptOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`[知伴健康 · 患者会话] ${settings.agentName}`);
  lines.push(`患者：${merged.patientId}`);
  lines.push(`群：${merged.groupName}（${merged.roomId}）`);
  lines.push(`本次发言人：${speakerLabel(merged.speaker)}`);

  if (options.groupContext && options.groupContext.length > 0) {
    lines.push('');
    lines.push('【近期群内上下文（内部员工发言，仅作背景，未触发本轮）】');
    for (const item of options.groupContext.slice(-8)) {
      lines.push(`- ${speakerLabel(item.speaker)}：${item.text}`);
    }
  }

  if (options.revisionInstruction) {
    lines.push('');
    lines.push('【顾问改稿指令】');
    lines.push(options.revisionInstruction);
    lines.push(`请按指令重写第 ${(options.currentVersion ?? 1) + 1} 版，并通过 reply_draft 提交。`);
  }

  if (options.proactive) {
    lines.push('');
    lines.push(`【主动触发】${options.proactive.reason}`);
  }

  lines.push('');
  lines.push('【本轮新增输入】');
  for (const message of merged.messages) lines.push(formatMessage(message));

  if (merged.speaker.role === 'family' || merged.speaker.role === 'unknown') {
    lines.push('');
    lines.push(
      `注意：本次发言人是「${ROLE_LABEL[merged.speaker.role]}」，不能把内容直接当作患者本人的事实；必要时在草稿里写明来源。`,
    );
  }

  lines.push('');
  lines.push('请调用 reply_draft 提交草稿。');
  return lines.join('\n');
}

/** 模板降级正文：模型超时 / 报错 / 没调工具时使用 */
export function fallbackBody(
  settings: TenantAgentSettings,
  patientName: string,
): string {
  const template =
    settings.fallbackTemplate ??
    '您好，已收到您的消息。{advisorName}稍后为您详细解答，如有紧急情况请直接来电。';
  return template
    .replaceAll('{agentName}', settings.agentName)
    .replaceAll('{advisorName}', settings.advisorName)
    .replaceAll('{patientName}', patientName);
}
