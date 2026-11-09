import type {
  Advisor,
  Alert,
  ArchivedInbound,
  AuditEvent,
  BotMessage,
  CardPayload,
  CustomerGroup,
  Draft,
  DraftStatus,
  SentMessage,
} from './types.ts';

export interface BotPort {
  sendCard(chatId: string, card: CardPayload): Promise<{ messageId: string }>;
  sendText(chatId: string, text: string): Promise<{ messageId: string }>;
  /**
   * #55：把患者原图转推给顾问。path 是服务端落盘路径；
   * 适配器负责读文件、校验格式与大小。未实现时队列跳过图片。
   */
  sendImage?(chatId: string, path: string): Promise<{ messageId: string }>;
}

export interface ArchivePort {
  listSentMessages(params: {
    fromUser: string;
    since: number;
    until: number;
  }): Promise<SentMessage[]>;

  /** 拉取指定群里的客户侧消息（发送者不是 excludeSender） */
  listInboundMessages(params: {
    roomIds: string[];
    excludeSender: string;
    since: number;
    until: number;
    /** #54：是否包含图片消息；缺省只返回文字 */
    includeMedia?: boolean;
  }): Promise<ArchivedInbound[]>;

  /**
   * #63：拉取指定群里的全部文字/图片消息（含内部员工），
   * 供患者插件区分「外部发言触发回合」与「内部发言只作上下文」。
   * 未实现的存档端口回退到 listInboundMessages。
   */
  listGroupMessages?(params: {
    roomIds: string[];
    since: number;
    until: number;
    includeMedia?: boolean;
  }): Promise<ArchivedInbound[]>;
}

export interface Clock {
  now(): number;
}

export interface Store {
  saveAdvisor(advisor: Advisor): void;
  getAdvisor(id: string): Advisor | undefined;
  listAdvisors(): Advisor[];

  saveGroup(group: CustomerGroup): void;
  getGroup(roomId: string): CustomerGroup | undefined;
  listGroups(): CustomerGroup[];

  saveDraft(draft: Draft): void;
  getDraft(id: string): Draft | undefined;
  listDrafts(): Draft[];
  /** QUEUED 且到达 nextAttemptAt，按 queuedAt 升序 */
  listQueued(advisorId: string, now: number): Draft[];
  listDraftsByStatus(status: DraftStatus): Draft[];

  getActiveDraft(advisorId: string): string | undefined;
  setActiveDraft(advisorId: string, draftId: string | undefined): void;

  appendAudit(event: AuditEvent): void;
  listAudit(): AuditEvent[];

  emitAlert(alert: Alert): void;
  listAlerts(): Alert[];
}

export interface BotSentRecord {
  chatId: string;
  kind: 'card' | 'text' | 'image';
  message: BotMessage;
  messageId: string;
  at: number;
}
