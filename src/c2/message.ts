import type { CardPayload, Draft, TextPayload } from './types.ts';

export const BUTTON_ACTIONS = ['sent', 'skipped'] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

const RISK_LABEL: Record<Draft['riskLevel'], string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/** 员工看的是手机时钟（东八区），服务器日志是 UTC，卡片一律按东八区显示 */
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function shanghaiClock(ms: number): string {
  return TIME_FORMAT.format(ms);
}

/**
 * 按钮 key 形如 ack:<draftId>:<action>。
 * draftId 不允许包含冒号（生成时保证）。
 */
export function buttonKey(draftId: string, action: ButtonAction): string {
  return `ack:${draftId}:${action}`;
}

export function parseButtonKey(key: string): { draftId: string; action: ButtonAction } | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'ack') return null;
  const action = parts[2] as ButtonAction;
  if (!BUTTON_ACTIONS.includes(action)) return null;
  return { draftId: parts[1], action };
}

/**
 * 第一条：上下文卡片。只放"这是给谁的、发到哪"，不放正文。
 *
 * 标题只放群名，一行说完就够员工认群；客户/时间/成员放在下面的行里，
 * 群名本身是「按成员拼出来的」时候不再重复列一遍成员。
 */
export function buildCard(draft: Draft, queueDepth: number): CardPayload {
  const ahead = Math.max(0, queueDepth - 1);
  const customer =
    draft.lastInboundAt === undefined
      ? draft.customerName
      : `${draft.customerName} · ${shanghaiClock(draft.lastInboundAt)}`;
  const showMembers =
    draft.groupNameSource !== 'members' &&
    draft.groupMembers !== undefined &&
    draft.groupMembers.length > 0;
  return {
    msgtype: 'template_card',
    template_card: {
      card_type: 'button_interaction',
      // 平台要求非空且唯一；带上 createdAt，重启后 draft_1 也不会撞车
      task_id: `c2-${draft.id}-${draft.createdAt.toString(36)}`.slice(0, 32),
      main_title: {
        title: `待回复 · ${draft.groupName}`,
        desc: ahead > 0 ? `后面还有 ${ahead} 条` : '当前仅此一条',
      },
      sub_title_text: `客户原文：${truncate(draft.inboundSummary, 80)}`,
      horizontal_content_list: [
        { keyname: '客户', value: truncate(customer, 60) },
        ...(showMembers
          ? [{ keyname: '群成员', value: truncate(draft.groupMembers!.join('、'), 60) }]
          : []),
        {
          keyname: '命中规则',
          value: draft.ruleIds.length > 0 ? draft.ruleIds.join('、') : '无',
        },
        { keyname: '风险', value: RISK_LABEL[draft.riskLevel] },
      ],
      button_list: [
        { text: '已发送', style: 1, key: buttonKey(draft.id, 'sent') },
        { text: '忽略', style: 4, key: buttonKey(draft.id, 'skipped') },
      ],
    },
  };
}

/**
 * 第二条：正文气泡。只含要发出去的内容，不拼接任何头部。
 * 员工长按复制这一条，不会把"发往 A 群"一起复制走。
 */
export function buildBody(draft: Draft): TextPayload {
  return { msgtype: 'text', text: { content: draft.body } };
}

export function buildDraftMessages(
  draft: Draft,
  queueDepth: number,
): { card: CardPayload; body: TextPayload } {
  return { card: buildCard(draft, queueDepth), body: buildBody(draft) };
}
