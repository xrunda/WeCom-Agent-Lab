/**
 * 患者会话端口与 C2 桥接端口。
 *
 * 这两个接口把 zhiban-patient 和 DSH / zhiban-wecom 隔开：
 * - PatientSessionPort：DSH 的「一位患者 = 一条长期会话」；
 * - PatientBridge：把 Agent 草稿交给 C2 入队/改稿，并读取活动草稿。
 * 单测用假实现，真机由插件 adapter 注入。
 */
import type { CustomerGroup, Draft, RiskLevel } from '../c2/types.ts';
import type { AgentStats, MergedInbound, Patient, PatientSessionRecord } from './types.ts';

export interface PatientSessionPort {
  /** 首次服务时创建 DSH 工作区与长期会话；已有则复用 */
  ensure(patient: Patient): Promise<PatientSessionRecord>;
  /** 注入一条患者消息并唤醒一轮 Agent */
  prompt(sessionId: string, text: string): Promise<void>;
  /** 把核验结果 / 内部发言作为上下文注入，不唤醒回合 */
  injectContext(sessionId: string, text: string): Promise<void>;
  /** 等当前回合结束；超时返回 timeout，不抛错 */
  waitIdle(sessionId: string, timeoutMs: number): Promise<'idle' | 'timeout'>;
}

export interface EnqueueAgentDraftInput {
  advisorId: string;
  groupRoomId: string;
  patientId: string;
  customerId: string;
  customerName: string;
  lastInboundAt?: number;
  inboundMessageIds: string[];
  mediaIds: string[];
  inboundSummary: string;
  body: string;
  riskLevel: RiskLevel;
  source: 'inbound' | 'proactive';
  fallback: boolean;
  citedMemoryIds: string[];
  citedKnowledgeIds: string[];
}

export interface ReviseAgentDraftInput {
  body: string;
  inboundSummary?: string;
  riskLevel?: RiskLevel;
  instruction: string;
  citedMemoryIds?: string[];
  citedKnowledgeIds?: string[];
}

export interface PatientBridge {
  enqueueDraft(input: EnqueueAgentDraftInput): Promise<{ draftId: string; version: number }>;
  reviseDraft(draftId: string, input: ReviseAgentDraftInput): Promise<{ draftId: string; version: number }>;
  requestRevision(draftId: string, instruction: string): void;
  getActiveDraft(advisorId: string): Draft | undefined;
  getDraft(draftId: string): Draft | undefined;
  /** 已核验/改后发送的正文，用于避免内部发言重复注入 */
  listVerifiedBodies(externalUserId: string): string[];
  notifyAdvisor(text: string): Promise<void>;
  /** C2 群绑定，供患者插件确保群存在（可选） */
  bindGroup?(group: CustomerGroup): void;
}

export interface PatientRuntimeDeps {
  bridge: PatientBridge;
  sessions: PatientSessionPort;
  /** 发到 DSH 事件总线 */
  emit: (type: string, data: unknown) => void;
  logger?: (line: string) => void;
  mergeWindowMs?: number;
  mergeMaxWaitMs?: number;
  turnTimeoutMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

export interface RuntimeStats extends AgentStats {
  mergedBatches: number;
  contextMessages: number;
  revisions: number;
  duplicatesSkipped: number;
}

export type { MergedInbound };
