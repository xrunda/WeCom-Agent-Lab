/**
 * #34 reply_draft / reply_skip 工具的参数校验与 DSH 定义。
 *
 * 工具是 Agent 唯一可以「产出草稿」的出口：普通文本回复不算。
 * 参数校验放在这里，便于单测；DSH 注册时再包一层 exec.agent.id 路由。
 */
import type { RiskLevel } from '../c2/types.ts';
import type { AgentReplyDraftInput, AgentReplySkipInput } from './types.ts';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string, violations: string[], max = 50): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    violations.push(`${field} 必须是字符串数组`);
    return [];
  }
  if (value.length > max) violations.push(`${field} 最多 ${max} 项`);
  return value as string[];
}

export function validateReplyDraft(args: unknown): ValidationResult<AgentReplyDraftInput> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };

  const body = typeof args.body === 'string' ? args.body.trim() : '';
  if (body.length === 0) violations.push('body 不能为空');
  if (body.length > 1000) violations.push('body 不能超过 1000 字');

  const summary = typeof args.inboundSummary === 'string' ? args.inboundSummary.trim() : '';
  if (summary.length === 0) violations.push('inboundSummary 不能为空');
  if (summary.length > 80) violations.push('inboundSummary 不能超过 80 字');

  const riskLevel = args.riskLevel;
  if (riskLevel !== 'low' && riskLevel !== 'medium' && riskLevel !== 'high') {
    violations.push('riskLevel 必须是 low / medium / high');
  }

  const citedMemoryIds = stringArray(args.citedMemoryIds, 'citedMemoryIds', violations);
  const citedKnowledgeIds = stringArray(args.citedKnowledgeIds, 'citedKnowledgeIds', violations);

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: {
      body,
      inboundSummary: summary,
      riskLevel: riskLevel as RiskLevel,
      citedMemoryIds,
      citedKnowledgeIds,
    },
  };
}

export function validateReplySkip(args: unknown): ValidationResult<AgentReplySkipInput> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (reason.length === 0) violations.push('reason 不能为空');
  if (reason.length > 200) violations.push('reason 不能超过 200 字');
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { reason } };
}

const STRING = { type: 'string' } as const;

export const REPLY_DRAFT_PARAMETERS = {
  type: 'object',
  properties: {
    body: {
      type: 'string',
      description:
        '要发给患者的正文（顾问会直接复制到客户群），纯文本，不超过 1000 字；以顾问口吻直接回复，不写来源说明或内部流程',
    },
    inboundSummary: { type: 'string', description: '本轮患者输入摘要，只用于卡片，不超过 80 字' },
    riskLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: '风险等级：涉及用药、急症、情绪危机用 high',
    },
    citedMemoryIds: { type: 'array', items: STRING, description: '引用的长期记忆 id' },
    citedKnowledgeIds: { type: 'array', items: STRING, description: '引用的知识库条目 id' },
  },
  required: ['body', 'inboundSummary', 'riskLevel'],
  additionalProperties: false,
} as const;

export const REPLY_SKIP_PARAMETERS = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: '为什么这一轮不需要回复，不超过 200 字' },
  },
  required: ['reason'],
  additionalProperties: false,
} as const;

export interface ReplyToolHandlers {
  replyDraft(sessionId: string, input: AgentReplyDraftInput): Promise<{ draftId: string; version: number }>;
  replySkip(sessionId: string, input: AgentReplySkipInput): Promise<{ skipped: true }>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  output: {
    schema: unknown;
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  timeoutMs?: number;
  execute(args: unknown, exec: { agent?: { id: string }; concludeTurn?(): void }): Promise<unknown>;
}

function toolError(violations: string[]): never {
  throw new Error(`INVALID_TOOL_ARGS ${violations.join('; ')}`);
}

const DRAFT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    draftId: { type: 'string' },
    version: { type: 'integer' },
  },
  required: ['draftId', 'version'],
  additionalProperties: false,
} as const;

const SKIP_RESULT_SCHEMA = {
  type: 'object',
  properties: { skipped: { type: 'boolean' } },
  required: ['skipped'],
  additionalProperties: false,
} as const;

/**
 * 生成 DSH 可直接注册的工具定义。`exec.agent.id` 是患者会话 id，
 * 由 PatientAgentRuntime 映射到当前回合；没有会话 id 时明确报错，
 * 避免控制台里的普通会话误产出患者草稿。
 */
export function buildReplyToolDefinitions(handlers: ReplyToolHandlers): RegisteredTool[] {
  return [
    {
      name: 'reply_draft',
      description:
        '提交一条可直接由顾问转发到客户群的回复草稿。每一轮客户消息都必须调用；正文以顾问口吻直接回复客户，不提群聊、存档、草稿或审核。',
      parameters: REPLY_DRAFT_PARAMETERS,
      output: {
        schema: DRAFT_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as { draftId: string; version: number };
          return [
            {
              type: 'text',
              text: `草稿已提交：${result.draftId}（第 ${result.version} 版），等待顾问确认。`,
            },
          ];
        },
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) toolError(['没有关联的 Agent 会话']);
        const parsed = validateReplyDraft(args);
        if (!parsed.ok) toolError(parsed.violations);
        const result = await handlers.replyDraft(sessionId, parsed.value);
        exec.concludeTurn?.();
        return result;
      },
    },
    {
      name: 'reply_skip',
      description: '本轮不需要回复时调用，并说明原因。不能与 reply_draft 同时调用。',
      parameters: REPLY_SKIP_PARAMETERS,
      output: {
        schema: SKIP_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as { skipped: boolean };
          return [{ type: 'text', text: result.skipped ? '已记录：本轮不回复。' : '未记录。' }];
        },
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) toolError(['没有关联的 Agent 会话']);
        const parsed = validateReplySkip(args);
        if (!parsed.ok) toolError(parsed.violations);
        const result = await handlers.replySkip(sessionId, parsed.value);
        exec.concludeTurn?.();
        return result;
      },
    },
  ];
}
