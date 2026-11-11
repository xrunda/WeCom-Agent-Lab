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
  /** P1 新增：管理员释放串行队列，当前草稿终结（data-model §4.1） */
  RELEASED: 'RELEASED',
} as const;

export type DraftStatus = (typeof DRAFT_STATUS)[keyof typeof DRAFT_STATUS];

/**
 * 员工对卡片的自报结果。
 * 只有「已发送 / 忽略」两种：是否照原文发出由存档回读判定（EDIT_SENT），不靠自报。
 */
export type AckAction = 'sent' | 'skipped';

export type RiskLevel = 'low' | 'medium' | 'high';

/** 草稿来源：#34 服务流据此区分「患者提问」与「Agent 主动」 */
export type DraftSource = 'inbound' | 'proactive';

/** 草稿的一个版本；#56 顾问改稿后追加，body 永远等于最大 version 的正文 */
export interface DraftRevision {
  version: number;
  body: string;
  /** 顾问改稿指令；v1 为空 */
  instruction?: string;
  createdBy: 'agent' | 'staff';
  createdAt: number;
}

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
  /** 合并窗口内的全部消息 id（#63）；v1 时至少一条，proactive 时为空数组 */
  inboundMessageIds?: string[];
  /** 本条输入附带的图片路径（#54 / #63） */
  mediaIds?: string[];
  /** #55：图片类型，卡片标注与质检用；如 ['meal'] */
  mediaKinds?: string[];
  /** #55：原图已转推给顾问的时间，避免重试重复发图 */
  mediaForwardedAt?: number;
  /** 客户原文摘要，只进卡片，不进正文 */
  inboundSummary: string;
  /** 要发出去的正文 */
  body: string;
  /** #37：命中的风险规则 id，供接口与详情展示 */
  ruleIds: string[];
  /** #37：命中的风险规则名称；卡片优先展示名称，旧数据为空时回退到 id */
  ruleNames?: string[];
  riskLevel: RiskLevel;
  status: DraftStatus;
  /** 当前版本号，从 1 开始（#56） */
  version?: number;
  /** 版本历史；body 永远等于最大 version 的正文 */
  revisions?: DraftRevision[];
  /** #34：inbound（患者提问）/ proactive（Agent 主动） */
  source?: DraftSource;
  /** 模板降级草稿（模型超时 / 报错 / 未调工具） */
  fallback?: boolean;
  /** 核验匹配到的实发版本 */
  sentVersion?: number;
  /** Agent 声明的引用，供详情页与质检使用 */
  citedMemoryIds?: string[];
  citedKnowledgeIds?: string[];
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
  /** #56：产生当前版本的改稿指令，卡片上显示「按你的要求：…」 */
  revisionInstruction?: string;
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

/** 存档里的客户侧消息：群聊中、发送者不是员工本人的消息 */
export interface ArchivedInbound {
  msgid: string;
  roomid: string;
  /** 发送者：外部客户为 wm 开头的个人微信 id */
  from: string;
  text: string;
  msgtime: number;
  action?: 'send' | 'recv';
  /** 存档消息类型；P1 只会为 text / image 生成记录 */
  msgtype?: string;
  /** #54：图片落盘后的本地路径；未启用媒体或下载失败时为空 */
  mediaPath?: string;
  mediaMd5?: string;
  mediaSize?: number;
  /** #54：下载失败（重试后）标记；消息仍保留在服务流中 */
  mediaFailed?: boolean;
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
  | 'UNVERIFIED'
  /** #32：停机超过阈值，期间消息不生成草稿 */
  | 'DOWNTIME'
  /** #65：demo 实例的长连接被服务端关闭（可能被开发实例顶掉） */
  | 'BOT_DISCONNECTED'
  /** #32：领域存储写入失败 */
  | 'PERSIST_FAILED';

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

/** #55：转推给顾问的患者原图（服务端路径） */
export interface ImagePayload {
  msgtype: 'image';
  image: { path: string };
}

export type BotMessage = CardPayload | TextPayload | ImagePayload;
