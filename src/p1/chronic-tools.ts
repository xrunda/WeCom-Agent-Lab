/**
 * chronic_record_write 工具定义。
 *
 * 只接受客户在对话里明确说出的数值（「今天早上血压 138/86」）或明确
 * 诊断（「我有高血压」），不做推断；报告图片里的数字不通过本工具写入。
 * 写入来源固定为 agent，控制台会展示「对话提取」，与顾问手工录入区分。
 */
import type { RegisteredTool } from './reply-tools.ts';
import {
  CHRONIC_CONDITION_PRESETS,
  CHRONIC_METRIC_KEYS,
  validateChronicRecord,
  type ChronicRecordInput,
} from './chronic.ts';

function toolError(violations: string[]): never {
  throw new Error(`INVALID_TOOL_ARGS ${violations.join('; ')}`);
}

export const CHRONIC_RECORD_PARAMETERS = {
  type: 'object',
  properties: {
    measurements: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: CHRONIC_METRIC_KEYS,
            description: '指标：bp 血压 / glucose 血糖 / hba1c 糖化血红蛋白 / weight 体重 / heart_rate 心率 / uric_acid 血尿酸 / ldl 低密度脂蛋白',
          },
          value: { type: 'number', description: '数值；血压填收缩压' },
          secondaryValue: { type: 'number', description: '血压的舒张压；其他指标不填' },
          context: {
            type: 'string',
            description: '测量情境，如「空腹」「餐后 2 小时」；血糖建议填写',
          },
          measuredAt: {
            type: 'string',
            description: '测量时间（ISO 8601）；客户没说时间就不填，按当前时间记录',
          },
        },
        required: ['metric', 'value'],
        additionalProperties: false,
      },
      description: '客户明确说出的体征数值，一次最多 5 条',
    },
    conditions: {
      type: 'array',
      maxItems: 10,
      items: { type: 'string' },
      description: `客户明确提到的慢病诊断；常见值：${CHRONIC_CONDITION_PRESETS.join('、')}`,
    },
    notes: {
      type: 'string',
      description: '补充说明，如「自测，未复测」；不要写推测',
    },
  },
  additionalProperties: false,
} as const;

export interface ChronicRecordResult {
  savedMeasurements: number;
  savedConditions: number;
  savedNotes: boolean;
  sandbox: boolean;
}

export interface ChronicToolHandlers {
  chronicRecordWrite(
    sessionId: string,
    input: ChronicRecordInput,
  ): ChronicRecordResult;
}

const CHRONIC_RECORD_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    savedMeasurements: { type: 'number' },
    savedConditions: { type: 'number' },
    savedNotes: { type: 'boolean' },
    sandbox: { type: 'boolean' },
  },
  required: ['savedMeasurements', 'savedConditions', 'savedNotes', 'sandbox'],
  additionalProperties: false,
} as const;

export function buildChronicToolDefinitions(handlers: ChronicToolHandlers): RegisteredTool[] {
  return [
    {
      name: 'chronic_record_write',
      description:
        '把客户在对话中明确说出的血压、血糖等体征、慢病诊断或用药情况写入慢病管理档案。' +
        '只记录客户原话里的明确数值，不做推断；化验单或报告图片里的数字不要通过本工具写入，' +
        '应建议顾问在控制台核对后录入。客户只是询问、没有提供数值时不要调用。',
      parameters: CHRONIC_RECORD_PARAMETERS,
      output: {
        schema: CHRONIC_RECORD_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as ChronicRecordResult;
          if (result.sandbox) {
            return [{ type: 'text', text: '体验沙盒不写慢病档案，本条未保存。' }];
          }
          const parts: string[] = [];
          if (result.savedMeasurements > 0) parts.push(`${result.savedMeasurements} 条体征`);
          if (result.savedConditions > 0) parts.push(`${result.savedConditions} 个慢病标签`);
          if (result.savedNotes) parts.push('备注');
          return [
            {
              type: 'text',
              text:
                parts.length > 0
                  ? `已写入慢病管理：${parts.join('、')}（来源：对话提取）。`
                  : '没有可写入的慢病信息。',
            },
          ];
        },
      },
      timeoutMs: 3000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id;
        if (!sessionId) toolError(['没有关联的 Agent 会话']);
        const parsed = validateChronicRecord(args, Date.now());
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.chronicRecordWrite(sessionId, parsed.value);
      },
    },
  ];
}
