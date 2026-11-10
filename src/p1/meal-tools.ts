/**
 * #55 meal_log_write / image_classify 工具定义。
 *
 * 与 reply_draft 一样通过 `exec.agent.id` 关联当前患者会话；
 * 参数校验放在这里，便于离线单测。
 */
import type { RegisteredTool } from './reply-tools.ts';
import {
  validateImageClassify,
  validateMealLogWrite,
  type ImageClassifyInput,
  type MealLogInput,
} from './vision.ts';

function toolError(violations: string[]): never {
  throw new Error(`INVALID_TOOL_ARGS ${violations.join('; ')}`);
}

export const IMAGE_CLASSIFY_PARAMETERS = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['meal', 'report', 'medicine', 'other'],
      description: '图片类型：餐食 / 体检或化验单 / 药品 / 其他',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: '类型判断置信度，0–1',
    },
    finding: {
      type: 'string',
      description: '一句话描述看到的场景，只供排查，不进入草稿',
    },
  },
  required: ['kind', 'confidence'],
  additionalProperties: false,
} as const;

export const MEAL_LOG_WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    foods: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '食物名称，如「清蒸鲈鱼」' },
          portion: { type: 'string', description: '大致份量，如「约 150g」，不确定可空' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      description: '识别到的食物与大致份量',
    },
    mealType: {
      type: 'string',
      enum: ['breakfast', 'lunch', 'dinner', 'snack', 'unknown'],
      description: '餐次；不确定填 unknown',
    },
    notes: { type: 'string', description: '补充说明，如「酱汁用量看不清」' },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: '识别置信度，0–1；低于 0.6 时草稿用询问句确认',
    },
  },
  required: ['foods', 'mealType', 'confidence'],
  additionalProperties: false,
} as const;

export interface MealToolHandlers {
  imageClassify(
    sessionId: string,
    input: ImageClassifyInput,
  ): { kind: ImageClassifyInput['kind']; accepted: true };
  mealLogWrite(
    sessionId: string,
    input: MealLogInput,
  ): { mealLogId: string; confidence: number; needsConfirmation: boolean };
}

const CLASSIFY_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    accepted: { type: 'boolean' },
  },
  required: ['kind', 'accepted'],
  additionalProperties: false,
} as const;

const MEAL_LOG_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    mealLogId: { type: 'string' },
    confidence: { type: 'number' },
    needsConfirmation: { type: 'boolean' },
  },
  required: ['mealLogId', 'confidence', 'needsConfirmation'],
  additionalProperties: false,
} as const;

export function buildMealToolDefinitions(handlers: MealToolHandlers): RegisteredTool[] {
  return [
    {
      name: 'image_classify',
      description:
        '判断本轮图片的类型。凡是本轮带图片就必须先调用；类型决定后续是否写饮食记录以及风险等级。',
      parameters: IMAGE_CLASSIFY_PARAMETERS,
      output: {
        schema: CLASSIFY_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as { kind: string; accepted: boolean };
          return [
            {
              type: 'text',
              text: result.accepted
                ? `已记录图片类型：${result.kind}。`
                : '图片类型未记录。',
            },
          ];
        },
      },
      timeoutMs: 3000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) toolError(['没有关联的 Agent 会话']);
        const parsed = validateImageClassify(args);
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.imageClassify(sessionId, parsed.value);
      },
    },
    {
      name: 'meal_log_write',
      description:
        '把餐食图片识别结果写入该患者的饮食记录。只有 meal 类型的图片才调用；识别不确定时降低 confidence。',
      parameters: MEAL_LOG_WRITE_PARAMETERS,
      output: {
        schema: MEAL_LOG_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as {
            mealLogId: string;
            confidence: number;
            needsConfirmation: boolean;
          };
          return [
            {
              type: 'text',
              text: result.needsConfirmation
                ? `饮食记录已保存（${result.mealLogId}），置信度较低，草稿请用询问句确认。`
                : `饮食记录已保存（${result.mealLogId}）。`,
            },
          ];
        },
      },
      timeoutMs: 3000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) toolError(['没有关联的 Agent 会话']);
        const parsed = validateMealLogWrite(args);
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.mealLogWrite(sessionId, parsed.value);
      },
    },
  ];
}
