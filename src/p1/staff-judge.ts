/**
 * 员工发言的语义复核（关键词初筛之后的第二层）。
 *
 * 关键词负责「不漏」：命中的一律进复核；模型负责「不误报」：判断这句话到底
 * 是在给客户下结论，还是在科普、建议就医、转述医生意见。
 *
 * 复核不可用（超时、模型报错、会话起不来）时返回 unknown，调用方按保守策略
 * 继续告警——宁可多看一条，也不能因为模型抖动漏掉真正的违规。
 */

export type StaffVerdict = 'violation' | 'ok' | 'unknown';

export interface StaffJudgeInput {
  /** 员工发言原文 */
  text: string;
  /** 命中的规则名，例如「不诊断」 */
  ruleNames: string[];
}

export interface StaffJudgePort {
  ask(prompt: string): Promise<string>;
}

/** 送进模型的原文上限：够判断语义，避免超长发言推高成本 */
const MAX_REVIEW_CHARS = 2_000;

export function buildStaffJudgePrompt(input: StaffJudgeInput): string {
  const text = input.text.slice(0, MAX_REVIEW_CHARS);
  const rules = input.ruleNames.join('、') || '健康红线';
  return [
    '你在做企业微信客户服务群的医疗合规质检。',
    `命中规则：${rules}。这些规则要求员工不能自己给客户下诊断、不能指导加减停药、不能承诺疗效。`,
    '下面是顾问在群里发的一段话，判断它是否真的违反了规则。',
    '',
    '算违规：以自己判断的口吻给客户下结论（「你就是糖尿病」「你这是肾病」）、指导停药减药加量、承诺治愈或包治。',
    '不算违规：科普知识、解释原理、建议就医检查、转述医生的意见、提醒注意事项、说明「这不算诊断」。',
    '',
    '只输出一行 JSON，不要任何解释：',
    '{"violation": true 或 false, "reason": "20 字以内"}',
    '',
    '顾问的话：',
    '"""',
    text,
    '"""',
  ].join('\n');
}

export function parseStaffVerdict(raw: string): StaffVerdict {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown';
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return 'unknown';
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return 'unknown';
    const violation = (parsed as { violation?: unknown }).violation;
    if (typeof violation !== 'boolean') return 'unknown';
    return violation ? 'violation' : 'ok';
  } catch {
    return 'unknown';
  }
}

export class StaffJudge {
  private readonly port: StaffJudgePort;

  constructor(port: StaffJudgePort) {
    this.port = port;
  }

  async judge(input: StaffJudgeInput): Promise<StaffVerdict> {
    try {
      const raw = await this.port.ask(buildStaffJudgePrompt(input));
      return parseStaffVerdict(raw);
    } catch {
      // 模型不可用不阻断链路：返回 unknown，由调用方按保守策略告警
      return 'unknown';
    }
  }
}
