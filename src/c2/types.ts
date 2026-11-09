/**
 * C2 领域模型。
 * 只定义类型与常量，不含逻辑；所有状态转移见 state-machine.ts。
 */

export const DRAFT_STATUS = {
  QUEUED: 'QUEUED',
  PUSHED: 'PUSHED',
  FAILED: 'FAILED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  SKIPPED: 'SKIPPED',
  VERIFIED: 'VERIFIED',
  EDIT_SENT: 'EDIT_SENT',
  MISROUTE_ALERT: 'MISROUTE_ALERT',
  UNVERIFIED: 'UNVERIFIED',
  DEAD_LETTER: 'DEAD_LETTER',
} as const;

export type DraftStatus = (typeof DRAFT_STATUS)[keyof typeof DRAFT_STATUS];

/**
 * 员工对卡片的自报结果。
 * 只有「已发送 / 忽略」两种：是否照原文发出由存档回读判定（EDIT_SENT），不靠自报。
 */
export type AckAction = 'sent' | 'skipped';

export type RiskLevel = 'low' | 'medium' | 'high';

export type AdvisorStatus = 'active' | 'paused' | 'left';

export type GroupStatus = 'mapped' | 'unassigned' | 'disabled';

export interface Advisor {
  id: string;
  name: string;
  /** 员工与机器人的 1:1 会话 ID；未完成开通时为空 */
  chatId?: string;
  status: AdvisorStatus;
  consecutiveMisroutes: number;
  noChatIdAlerted?: boolean;
}

export interface CustomerGroup {
  /** 会话存档中的群 ID */
  roomId: string;
  /** 客户群接口的 chat_id，可能不同 */
  chatId?: string;
  name: string;
  advisorId: string;
  status: GroupStatus;
}

/** 群名是从哪来的：决定卡片要不要再列群成员（群名本身就是成员拼接时再列一遍是重复） */
export type GroupNameSource = 'config' | 'api' | 'members' | 'roomid';

export interface Draft {
  id: string;
  advisorId: string;
  groupRoomId: string;
  groupName: string;
  groupNameSource?: GroupNameSource;
  /** 群里能看到的成员（员工自己除外），帮员工确认是不是这个群 */
  groupMembers?: string[];
  customerId: string;
  customerName: string;
  /** 客户这条消息发出（落存档）的时刻，卡片上显示成「客户 · 22:26」 */
  lastInboundAt?: number;
  inboundMessageId: string;
  /** 客户原文摘要，只进卡片，不进正文 */
  inboundSummary: string;
  /** 要发出去的正文 */
  body: string;
  ruleIds: string[];
  riskLevel: RiskLevel;
  status: DraftStatus;
  createdAt: number;
  queuedAt: number;
  nextAttemptAt: number;
  pushAttempts: number;
  pushedAt?: number;
  cardMessageId?: string;
  bodyMessageId?: string;
  remindedAt?: number;
  escalatedAt?: number;
  ackAt?: number;
  ackAction?: AckAction;
  verifyAttempts: number;
  nextVerifyAt?: number;
  verification?: VerificationResult;
  errorCode?: string;
}

export type VerifyOutcome =
  | 'VERIFIED'
  | 'EDIT_SENT'
  | 'MISROUTE_ALERT'
  | 'UNVERIFIED';

export interface VerificationResult {
  /** 对应的草稿 id，便于上层把结果回执给员工 */
  draftId?: string;
  outcome: VerifyOutcome;
  matchedMsgId?: string;
  matchedRoomId?: string;
  similarity?: number;
  checkedAt: number;
}

export interface SentMessage {
  msgid: string;
  roomid: string;
  from: string;
  text: string;
  msgtime: number;
}

/** 存档里的客户侧消息：群聊中、发送者不是员工本人的文字消息 */
export interface ArchivedInbound {
  msgid: string;
  roomid: string;
  /** 发送者：外部客户为 wm 开头的个人微信 id */
  from: string;
  text: string;
  msgtime: number;
  action?: 'send' | 'recv';
}

export interface AuditEvent {
  at: number;
  actor: string;
  action: string;
  target: string;
  result: string;
  errorCode?: string;
}

export type AlertKind =
  | 'NO_CHATID'
  | 'PUSH_FAILED'
  | 'DEAD_LETTER'
  | 'MISROUTE'
  | 'ADVISOR_PAUSED'
  | 'ESCALATED'
  | 'UNVERIFIED';

export interface Alert {
  kind: AlertKind;
  message: string;
  at: number;
  advisorId?: string;
  draftId?: string;
}

export interface CardPayload {
  msgtype: 'template_card';
  template_card: {
    card_type: 'button_interaction';
    /** 平台要求：每条卡片唯一，不能为空；重复推送同一 task_id 会返回 42014 */
    task_id: string;
    main_title: { title: string; desc?: string };
    sub_title_text?: string;
    horizontal_content_list?: Array<{ keyname: string; value: string }>;
    button_list: Array<{ text: string; style: 1 | 2 | 3 | 4; key: string }>;
  };
}

export interface TextPayload {
  msgtype: 'text';
  text: { content: string };
}

export type BotMessage = CardPayload | TextPayload;
