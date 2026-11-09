/**
 * #36 schedule_create 的参数校验与 DSH 定义。
 *
 * Agent 在对话里识别到「提醒 / 回访」意图时调用；时间支持毫秒时间戳、
 * ISO 8601 字符串或相对秒数。到期后的投递与限流由 zhiban-care 负责，
 * 这里只做参数校验与患者解析。
 */
import type { RegisteredTool } from './reply-tools.ts';
import { CARE_TITLE_MAX, type CarePlanCreateInput, type CarePlanRecord } from './care.ts';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ScheduleCreateArgs {
  title: string;
  /** 由 when / afterSeconds 换算出的绝对时间 */
  when?: number;
  afterSeconds?: number;
}

function parseWhen(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function validateScheduleCreate(
  args: unknown,
  now = Date.now(),
): ValidationResult<ScheduleCreateArgs> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title === '') violations.push('title 不能为空');
  if (title.length > CARE_TITLE_MAX) violations.push(`title 不能超过 ${CARE_TITLE_MAX} 字`);

  const hasWhen = args.when !== undefined && args.when !== null;
  const hasAfter = args.afterSeconds !== undefined && args.afterSeconds !== null;
  if (!hasWhen && !hasAfter) violations.push('when 与 afterSeconds 至少提供一个');
  if (hasWhen && hasAfter) violations.push('when 与 afterSeconds 不能同时提供');

  let when: number | undefined;
  if (hasWhen) {
    when = parseWhen(args.when);
    if (when === undefined) violations.push('when 必须是毫秒时间戳或 ISO 8601 字符串');
  }

  let afterSeconds: number | undefined;
  if (hasAfter) {
    if (
      typeof args.afterSeconds !== 'number' ||
      !Number.isFinite(args.afterSeconds) ||
      args.afterSeconds <= 0
    ) {
      violations.push('afterSeconds 必须是正数（秒）');
    } else {
      afterSeconds = Math.round(args.afterSeconds);
      when = now + afterSeconds * 1000;
    }
  }

  if (when !== undefined && when <= now) violations.push('when 必须晚于当前时间');

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { title, when, afterSeconds } };
}

const STRING = { type: 'string' } as const;

export const SCHEDULE_CREATE_PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '计划名称，例如「提醒量血压」，不超过 120 字' },
    when: {
      type: 'string',
      description: '绝对时间：ISO 8601（如 2026-11-11T08:00:00+08:00）或毫秒时间戳字符串',
    },
    afterSeconds: { type: 'number', description: '相对当前时间的秒数，与 when 二选一' },
  },
  required: ['title'],
  additionalProperties: false,
} as const;

const PLAN_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    planId: { type: 'string' },
    title: { type: 'string' },
    when: { type: 'number' },
    status: { type: 'string' },
    quietHoursShifted: { type: 'boolean' },
  },
  required: ['planId', 'title', 'when', 'status', 'quietHoursShifted'],
  additionalProperties: false,
} as const;

export interface CareToolHandlers {
  /** 会话 → 患者；解析不到时返回 undefined */
  patientForSession(sessionId: string): string | undefined;
  create(input: CarePlanCreateInput): CarePlanRecord;
}

function toolError(violations: string[]): never {
  throw new Error(`INVALID_TOOL_ARGS ${violations.join('; ')}`);
}

export function buildCareToolDefinitions(handlers: CareToolHandlers): RegisteredTool[] {
  return [
    {
      name: 'schedule_create',
      description:
        '创建一条一次性主动计划：到点后系统会提醒你给患者发关怀消息。用户说「明天早上提醒我量血压」「三天后回访」时调用。',
      parameters: SCHEDULE_CREATE_PARAMETERS,
      output: {
        schema: PLAN_RESULT_SCHEMA,
        render: (_args, value) => {
          const plan = value as {
            title: string;
            when: number;
            quietHoursShifted: boolean;
          };
          const time = new Date(plan.when).toISOString();
          const shifted = plan.quietHoursShifted ? '（已避开安静时段）' : '';
          return [{ type: 'text', text: `已创建计划「${plan.title}」，触发时间 ${time}${shifted}。` }];
        },
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) toolError(['没有关联的 Agent 会话']);
        const parsed = validateScheduleCreate(args);
        if (!parsed.ok) toolError(parsed.violations);
        const patientId = handlers.patientForSession(sessionId);
        if (!patientId) toolError(['当前会话没有关联患者，不能创建计划']);
        const plan = handlers.create({
          patientId,
          title: parsed.value.title,
          when: parsed.value.when!,
          source: 'agent',
        });
        return {
          planId: plan.id,
          title: plan.title,
          when: plan.when,
          status: plan.status,
          quietHoursShifted: plan.quietHoursShifted,
        };
      },
    },
  ];
}
