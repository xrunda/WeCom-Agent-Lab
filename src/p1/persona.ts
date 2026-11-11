/**
 * #34 人设与回合输入；#63 发言人身份 / 角色；#56 改稿指令。
 *
 * 提示词一律由租户设置生成，不在代码里写死机构名；
 * 红线条款每次回合都带上，不能靠模型记性。
 */
import type {
  AgentCapabilities,
  InboundMessage,
  MergedInbound,
  Speaker,
  TenantAgentSettings,
} from './types.ts';
import { imageInstructionBlock } from './vision.ts';

export const RED_LINES = [
  '不做诊断、不调整药物剂量、不承诺疗效；涉及用药与检查结论时，只建议咨询医生。',
  '出现胸痛、呼吸困难、意识改变、大出血等急症描述时，立即建议拨打 120 或去急诊，不继续给生活建议。',
  '你产出的只是草稿，必须由顾问确认后才会发出；不要写成「我已经帮你安排好了」。',
  '草稿正文是顾问会直接复制发到客户群的最终消息：以顾问的口吻直接对客户说，开头直接回应问题；不要出现「群里」「群内」「存档」「草稿」「审核」「有人问」「机器人」「AI」等内部视角或来源说明。',
  '家属或角色未知的成员发言，不能当作患者本人的事实，也不要编造患者本人的情况；需要核实时，用自然的提问在正文里确认（如「请问是您本人还是家属？」），不要写「家属说」「群里有人提到」这类来源说明。',
  '不输出其他患者、其他群成员的个人信息；不猜测未提供的隐私。',
  '未同意会话存档的成员，其内容不进入自动服务；只提示顾问人工跟进。',
];

export function buildSystemPrompt(
  settings: TenantAgentSettings,
  capabilities: AgentCapabilities = { memory: false, care: false },
): string {
  const tools = [
    '- 每一轮都必须调用 reply_draft 提交草稿；不要用普通文本回复代替。',
    '- 如果这一轮不需要回复（例如只是内部同事寒暄、或信息不足且不适合回复），调用 reply_skip 并写明原因。',
    '- 草稿正文只包含要发给患者的话，并且可以直接转发：以顾问口吻直接回复，不写「群里有人问」「家属说」等来源说明，也不写「草稿」「请审核」等内部说明。',
    '- 正文尽量控制在 500 字以内：先直接回应问题，再给最重要的 3–5 条；细节可邀请客户继续问。',
  ];
  if (capabilities.memory) {
    tools.push(
      '- 长期记忆只记患者或家属明确说过的稳定事实，不记推断、不记寒暄；用 memory_write 记录，用 memory_update 修正，用 memory_list 查询。',
      '- 家属说的事 subject=family，不能算作患者本人的事实。记错或患者改口时用 memory_update 修正，不要重复新增。',
      '- 每轮提示词会附上该患者的长期记忆；草稿引用了哪条，就把它的 id 填进 citedMemoryIds。',
    );
  }
  if (capabilities.care) {
    tools.push(
      '- 用户说「明天提醒我…」「三天后回访」时调用 schedule_create 建一次性计划；时间必须晚于当前时刻。',
      '- 计划到期后系统会触发一轮主动回合，届时应判断是否真的需要发关怀消息；不需要就 reply_skip。',
    );
  }
  return [
    `你是「${settings.agentName}」，${settings.advisorName} 团队的健康助理。`,
    `服务对象统一称呼为「${settings.patientTerm}」。语气：${settings.tone}。`,
    '你的回复不会直接发给患者，而是作为草稿交给顾问审核后发出。',
    '',
    '【红线】',
    ...RED_LINES.map((line, index) => `${index + 1}. ${line}`),
    '',
    '【工具约定】',
    ...tools,
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
  if (message.msgtype === 'voice') {
    return `- ${time} [语音] ${message.text}`;
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
  /** #35：本患者有效记忆，每轮注入 */
  memoryLines?: string[];
  /** #55：本轮实际注入的图片张数；0 时不出现图片说明 */
  imageCount?: number;
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
  if (options.proactive) {
    lines.push('本轮由主动计划触发，没有新的患者消息。');
  } else {
    lines.push(`本次发言人：${speakerLabel(merged.speaker)}`);
  }

  if (options.memoryLines && options.memoryLines.length > 0) {
    lines.push('');
    lines.push(...options.memoryLines);
  }

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
    lines.push('请判断现在是否适合给患者发一条关怀消息；不需要就调用 reply_skip。');
  }

  lines.push('');
  lines.push('【本轮新增输入】');
  if (merged.messages.length === 0) {
    lines.push('- （无新消息）');
  }
  for (const message of merged.messages) lines.push(formatMessage(message));

  if (!options.proactive && (merged.speaker.role === 'family' || merged.speaker.role === 'unknown')) {
    lines.push('');
    lines.push(
      `注意：本次发言人是「${ROLE_LABEL[merged.speaker.role]}」，不能把内容直接当作患者本人的事实，也不要编造患者本人的情况。` +
        '需要核实时，用自然的提问在正文里确认（例如「请问是您本人还是家属？」）；' +
        '正文不要写「家属说」「群里有人提到」等来源说明，它会被顾问直接转发到客户群。',
    );
  }

  if (options.imageCount && options.imageCount > 0) {
    lines.push('');
    lines.push(imageInstructionBlock(options.imageCount));
  }

  lines.push('');
  lines.push(
    options.proactive
      ? '需要发消息请调用 reply_draft；不需要请调用 reply_skip。'
      : '请调用 reply_draft 提交草稿。',
  );
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
