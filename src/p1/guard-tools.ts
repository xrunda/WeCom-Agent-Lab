/**
 * #37 escalate_to_human 工具：Agent 判断需要人工接手时调用。
 *
 * 只接受原因枚举，不收患者原文，避免告警与日志里出现消息正文。
 */
import type { RegisteredTool, ValidationResult } from './reply-tools.ts';
import { ESCALATE_REASONS, ESCALATE_REASON_LABEL } from './guard.ts';
import type { EscalateReason, GuardAlertRecord } from './guard.ts';

export interface EscalateInput {
  reason: EscalateReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEscalate(args: unknown): ValidationResult<EscalateInput> {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  if (!ESCALATE_REASONS.includes(args.reason as EscalateReason)) {
    return { ok: false, violations: [`reason 必须是 ${ESCALATE_REASONS.join('/')}`] };
  }
  return { ok: true, value: { reason: args.reason as EscalateReason } };
}

export const ESCALATE_PARAMETERS = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      enum: [...ESCALATE_REASONS],
      description: '升级原因：急症症状 / 患者要求人工 / 其他',
    },
  },
  required: ['reason'],
  additionalProperties: false,
} as const;

const ESCALATE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    alertId: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['alertId', 'reason'],
  additionalProperties: false,
} as const;

export interface EscalateToolHandlers {
  /** 会话 → 患者；找不到返回 undefined */
  patientForSession(sessionId: string): string | undefined;
  escalate(sessionId: string, patientId: string, reason: EscalateReason): GuardAlertRecord;
}

export function buildGuardToolDefinitions(handlers: EscalateToolHandlers): RegisteredTool[] {
  return [
    {
      name: 'escalate_to_human',
      description:
        '需要顾问人工接手时调用（急症、患者明确要求人工、或情况超出服务范围）。不要与 reply_draft 冲突：已经能安全起草时不需要升级。',
      parameters: ESCALATE_PARAMETERS,
      output: {
        schema: ESCALATE_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as { alertId: string; reason: string };
          return [
            {
              type: 'text',
              text: `已通知顾问人工接手（${ESCALATE_REASON_LABEL[result.reason as EscalateReason]}）。`,
            },
          ];
        },
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) throw new Error('INVALID_TOOL_ARGS 没有关联的 Agent 会话');
        const parsed = validateEscalate(args);
        if (!parsed.ok) throw new Error(`INVALID_TOOL_ARGS ${parsed.violations.join('; ')}`);
        const patientId = handlers.patientForSession(sessionId);
        if (!patientId) {
          throw new Error('INVALID_TOOL_ARGS 当前会话没有关联患者，不能升级');
        }
        const alert = handlers.escalate(sessionId, patientId, parsed.value.reason);
        return { alertId: alert.id, reason: parsed.value.reason };
      },
    },
  ];
}
