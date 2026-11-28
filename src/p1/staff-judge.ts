/**
 * 健康红线的语义复核（关键词初筛之后的第二层）。
 *
 * 关键词负责「不漏」：命中的一律进复核；模型负责「不误报」：判断这段文字
 * 到底是在给客户下结论/调药/承诺疗效，还是在科普、建议就医、转述医生意见。
 *
 * 员工群里已经发出去的发言、还没发出去的 AI 草稿共用这套复核，只是提示词
 * 与等待时长不同：草稿卡在回合里，等太久会把整个回合拖过超时。
 *
 * 复核不可用（超时、模型报错、会话起不来）时返回 unknown，调用方按保守策略
 * 继续告警——宁可多看一条，也不能因为模型抖动漏掉真正的违规。
 */

export type StaffVerdict = 'violation' | 'ok' | 'unknown';

export interface StaffJudgeInput {
  /** 待复核的原文：员工发言或 AI 草稿正文 */
  text: string;
  /** 命中的规则名，例如「不诊断」 */
  ruleNames: string[];
}

export interface StaffJudgePort {
  /** timeoutMs 由调用方决定：草稿要短，员工发言可以等久一点 */
  ask(prompt: string, timeoutMs?: number): Promise<string>;
}

/**
 * 草稿复核的等待上限。草稿要在这个回合里入队，等太久会把回合拖过 turnTimeout，
 * 退化成模板草稿；等不到就按关键词保守处理，和复核不可用同一套策略。
 */
export const DRAFT_JUDGE_TIMEOUT_MS = 4_000;

/** 送进模型的原文上限：够判断语义，避免超长发言推高成本 */
const MAX_REVIEW_CHARS = 2_000;

export function buildStaffJudgePrompt(input: StaffJudgeInput): string {
  const text = input.text.slice(0, MAX_REVIEW_CHARS);
  const rules = input.ruleNames.join('、') || '健康红线';
  return [
    '你在做企业微信客户服务群的医疗合规质检。',
    `命中规则：${rules}。这些规则要求员工不能自己给客户下诊断、不能推荐或调整用药、不能承诺疗效。`,
    '下面是顾问在群里发的一段话，判断它是否真的违反了规则。',
    '',
    '算违规：以自己判断的口吻给客户下结论（「你就是糖尿病」「你这是肾病」）、指导或建议客户吃/停/换某种药、增减剂量或用法（「建议口服一片降糖药」「可以吃两片」「先停掉」）、承诺治愈或包治。',
    '不算违规：科普知识、解释原理、建议就医检查、建议按医嘱服药或转述医生给的用药方案（「按医生开的剂量吃」「把药盒带给医生看」）、提醒注意事项、说明「这不算诊断」。',
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

/**
 * 草稿复核的提示词：对象是「准备发给客户的回复」，还没发出去。
 * 重点区分「替客户做医疗决定」和「提醒客户不要自己动药、去找医生」。
 */
export function buildDraftJudgePrompt(input: StaffJudgeInput): string {
  const text = input.text.slice(0, MAX_REVIEW_CHARS);
  const rules = input.ruleNames.join('、') || '健康红线';
  return [
    '你在做医疗健康服务的合规质检。',
    `下面是一段准备发给客户的回复草稿，关键词初筛命中了：${rules}。`,
    '规则要求回复不能替客户下诊断、不能推荐或调整用药、不能承诺疗效。判断这段草稿是否真的违反了规则。',
    '',
    '算违规：给客户下结论（「您这就是糖尿病」）、指导或建议客户吃/停/换某种药、增减剂量或用法（「建议口服一片降糖药」「可以吃两片」「先停掉」「减量到半片」）、承诺治愈或包治。',
    '不算违规：提醒客户不要自己停药或减量、提醒找医生调整用药、建议就医检查、按医嘱服药、科普与生活方式建议（饮食、运动、测血压血糖）、引用医生已给出的方案。',
    '',
    '只输出一行 JSON，不要任何解释：',
    '{"violation": true 或 false, "reason": "20 字以内"}',
    '',
    '草稿：',
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
    return await this.run(buildStaffJudgePrompt(input));
  }

  /** 草稿侧的复核：提示词按「发给客户的回复」写，等待时长也更短 */
  async judgeDraft(input: StaffJudgeInput): Promise<StaffVerdict> {
    return await this.run(buildDraftJudgePrompt(input), DRAFT_JUDGE_TIMEOUT_MS);
  }

  private async run(prompt: string, timeoutMs?: number): Promise<StaffVerdict> {
    try {
      const raw = await this.port.ask(prompt, timeoutMs);
      return parseStaffVerdict(raw);
    } catch {
      // 模型不可用不阻断链路：返回 unknown，由调用方按保守策略告警
      return 'unknown';
    }
  }
}
