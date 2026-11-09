/**
 * P1 患者域模型（#33 / #34 / #63 / #56）。
 *
 * 与 docs/P1-data-model.md 对齐：群状态、群成员角色、患者、绑定关系、
 * 患者会话、顾问表。字段尽量保持可空，方便旧快照与手工录入共存。
 */
import type { Draft, RiskLevel } from '../c2/types.ts';

export type GroupServiceStatus = 'pending' | 'serving' | 'collect_only' | 'disabled';

export type MemberRole = 'self' | 'family' | 'advisor' | 'colleague' | 'unknown';

export type ConsentStatus = 'agreed' | 'unknown' | 'disagreed';

export type PatientStatus = 'serving' | 'paused' | 'archived';

export type GroupNameSource = 'config' | 'api' | 'members' | 'roomid';

export type ServiceLevel = 'serve' | 'collect_only' | 'none';

export interface AdvisorRecord {
  id: string;
  tenantId: string;
  wecomUserId: string;
  name: string;
  status: 'active' | 'paused' | 'left';
  /** 会话存档席位到期时间 */
  seatExpireAt?: number;
  chatBound: boolean;
  /** C2 兼容字段：连续错群次数 */
  consecutiveMisroutes: number;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedGroup {
  id: string;
  tenantId: string;
  roomId: string;
  chatId?: string;
  name: string;
  nameSource: GroupNameSource;
  status: GroupServiceStatus;
  /** pending 时可能为空 */
  advisorId?: string;
  memberCount: number;
  externalMemberCount: number;
  lastActiveAt?: number;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface GroupMember {
  id: string;
  tenantId: string;
  groupId: string;
  /** 外部成员企微 id（wm...）；内部员工为空 */
  externalUserId?: string;
  /** 外部成员 id 后 6 位，界面展示用 */
  externalUserIdTail?: string;
  displayName: string;
  isExternal: boolean;
  /** 内部员工企微 userid */
  staffUserId?: string;
  role: MemberRole;
  consent: ConsentStatus;
  lastActiveAt?: number;
  annotatedBy?: string;
  annotatedAt?: number;
}

export interface GroupBinding {
  id: string;
  tenantId: string;
  groupId: string;
  patientId: string;
  isPrimary: boolean;
  createdAt: number;
  deletedAt?: number;
}

export interface Patient {
  id: string;
  tenantId: string;
  displayName: string;
  avatar?: string;
  /** 主外部成员 id（wm...），用于路由与同意状态 */
  externalUserId?: string;
  tags: string[];
  advisorId?: string;
  groupIds?: string[];
  consent: ConsentStatus;
  consentCheckedAt?: number;
  status: PatientStatus;
  demo: boolean;
  accompaniedSince: number;
  lastActiveAt?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface PatientSessionRecord {
  patientId: string;
  sessionId: string;
  workspacePath: string;
  createdAt: number;
}

/** 存档里的一条消息（患者域只关心会话内容，不关心 C2 草稿状态） */
export interface InboundMessage {
  msgid: string;
  roomId: string;
  from: string;
  text: string;
  msgtime: number;
  msgtype?: string;
  mediaPath?: string;
}

export interface Speaker {
  id: string;
  displayName: string;
  role: MemberRole;
  isExternal: boolean;
}

/** 合并窗口结束后交给 Agent 的一批输入；主动计划回合没有 messages */
export interface MergedInbound {
  /** 进程内批次 id */
  id: string;
  roomId: string;
  groupId: string;
  groupName: string;
  patientId: string;
  advisorId: string;
  messages: InboundMessage[];
  speaker: Speaker;
  source: 'inbound' | 'proactive';
  /** #36：主动计划回合的触发原因 */
  proactive?: { planId: string; title: string };
  mergedAt: number;
  lastMessageAt: number;
}

/** #35 每轮注入记忆；插件未安装时 available() 为 false */
export interface PatientMemoryPort {
  available(): boolean;
  render(patientId: string): string[];
}

/** #35 / #36 能力开关，用于系统提示词里的工具约定 */
export interface AgentCapabilities {
  memory: boolean;
  care: boolean;
}

/** Agent 通过 reply_draft 工具提交的草稿 */
export interface AgentReplyDraftInput {
  body: string;
  inboundSummary: string;
  riskLevel: RiskLevel;
  citedMemoryIds: string[];
  citedKnowledgeIds: string[];
}

export interface AgentReplySkipInput {
  reason: string;
}

export interface RouteDecision {
  action: 'turn' | 'context' | 'ignore';
  reason: string;
  patientId?: string;
  groupId?: string;
  /** 未同意的成员：界面提示「该成员未同意存档，需人工服务」 */
  consentNotice?: string;
}

/** #34 降级统计 */
export interface AgentStats {
  turns: number;
  replies: number;
  skips: number;
  fallbacks: number;
  timeouts: number;
  errors: number;
}

/** 患者域需要的最小 C2 草稿视图，便于离线测试 */
export type DraftView = Pick<Draft, 'id' | 'advisorId' | 'groupRoomId' | 'customerId' | 'status' | 'version' | 'body'>;

export interface TenantAgentSettings {
  agentName: string;
  /** 患者 / 客户 / 会员，按租户配置 */
  patientTerm: string;
  tone: string;
  advisorName: string;
  /** 默认顾问 id（群未绑定顾问时使用） */
  advisorId: string;
  /** 模板降级正文；可用 {agentName} {advisorName} {patientName} 占位 */
  fallbackTemplate?: string;
}
