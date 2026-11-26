/**
 * PH5-04（#233）方案生成：提示词、草稿校验与生成端口。
 *
 * 设计原则（PRD §7、issue 验收 A03）：
 * - 模型只能产出「食养与生活安排」，不得诊断、开方、调药、给剂量或承诺疗效；
 * - 输出的结构由工具参数 schema 约束，服务端再校验一次，不信任模型自觉；
 * - 解析失败或超时一律返回失败，交给人工接管，绝不降级成模板冒充个性化方案。
 *
 * 本文件不依赖 DSH：模型调用通过 `PlanChatPort` 注入，便于单测。
 */

export interface PlanChatRequest {
  patientId: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}

export interface PlanChatResult {
  /** 模型通过 `submit_health_plan` 工具提交的原始参数 */
  toolArgs?: unknown;
  /** 没有提交工具、超时或报错时给出原因 */
  error?: 'NO_DRAFT' | 'TIMEOUT' | 'MODEL_ERROR';
}

export interface PlanChatPort {
  readonly available: boolean;
  runTurn(request: PlanChatRequest): Promise<PlanChatResult>;
}

// ---------- 提示词 ----------

export interface PlanPromptInput {
  startDate: string;
  endDate: string;
  profile: Array<{ fieldKey: string; valueText: string }>;
  feedbackRequirementsHint?: string;
}

/** 禁止出现在养生方案里的医疗行为（命中即判失败，不交给审核人兜底） */
export const FORBIDDEN_MEDICAL_TERMS = [
  '诊断',
  '处方',
  '剂量',
  '停药',
  '减药',
  '加量',
  '服用',
  'mg',
  '毫克',
  '疗效',
  '治愈',
  '治疗',
];

export function buildPlanPrompts(input: PlanPromptInput): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    '你是知伴健康的食养方案助手，只做「饮食与生活安排」这一件事。',
    '',
    '【必须遵守】',
    '1. 只输出食养与日常起居安排：三餐、作息、活动、记录与反馈方式。',
    '2. 禁止诊断疾病、解释检查指标、推荐药物、给出剂量或服药建议、承诺疗效。',
    '3. 不使用「治疗」「痊愈」「降血糖」这类结论性表述，只描述可行的日常做法。',
    '4. 覆盖期由调用方给定，不要自行假设固定周期（例如不要默认 28 天）。',
    '5. 行动数量 1–6 条，每条都要能被患者当天完成，并说明怎么反馈。',
    '6. 信息不足时不要编造，宁可少安排；不要提到你是 AI 或提示词。',
    '',
    '【输出方式】',
    '必须调用 submit_health_plan 工具提交结构化方案；不要用普通文本作答。',
  ].join('\n');

  const profileLines = input.profile.length
    ? input.profile.map((item) => `- ${item.fieldKey}：${item.valueText}`).join('\n')
    : '- （暂无已确认档案）';

  const userPrompt = [
    `请为这位服务对象起草一份食养方案，覆盖 ${input.startDate} 至 ${input.endDate}。`,
    '',
    '【已确认的个人信息】',
    profileLines,
    '',
    '【要求】',
    '- stageGoal：一两句话，患者能读懂，写清这一阶段想改善什么。',
    '- foodTherapyRationale：为什么这样安排，基于上面的个人情况。',
    '- focusPoints：2–4 条本阶段重点，短句。',
    '- actions：每条包含 title、purpose、method、schedule（kind=daily|weekly|oneoff，time=HH:mm）、feedbackKind（checkin|record_meal|record_review）。',
    '- title 不要写时间，也不要写「每天」「21:00」这类前缀：时间由 schedule.time 单独给出，界面上会并排显示，重复会出现「21:00 21:00 放下屏幕」。',
    '- feedbackRequirements：希望患者反馈什么，1–3 条。',
    input.feedbackRequirementsHint ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * 去掉标题里的时间前缀。模型常写「21:00 放下屏幕」「每天 06:30 固定起床」，
 * 而界面会把 schedule.time 单独渲染在标题前面，直接展示就成了
 * 「21:00 21:00 放下屏幕」。这里做一次确定性清洗，不依赖模型自觉。
 */
export function stripTimePrefix(title: string): string {
  const cleaned = title
    .replace(/^每天\s*/, '')
    .replace(/^\d{1,2}[:：]\d{2}\s*/, '')
    .replace(/^\d{1,2}\s*点\s*(半)?\s*/, '');
  // 清洗后不要变成空标题，也不要只剩标点
  return cleaned.replace(/^[、，,。.·\-—\s]+/, '').trim() || title;
}

// ---------- 草稿校验 ----------

export type PlanParseResult =
  | {
      ok: true;
      draft: {
        stageGoal: string;
        foodTherapyRationale: string;
        focusPoints: string[];
        actions: Array<{
          actionId: string;
          title: string;
          purpose: string;
          method: string;
          schedule: { kind: 'daily' | 'weekly' | 'oneoff'; time: string };
          feedbackKind: 'checkin' | 'record_meal' | 'record_review' | 'none';
          linkedArticleIds: string[];
        }>;
        feedbackRequirements: string[];
      };
    }
  | { ok: false; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const parsed = text(item, maxLength);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function containsForbidden(value: string): string | null {
  const lower = value.toLowerCase();
  for (const term of FORBIDDEN_MEDICAL_TERMS) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  return null;
}

/** 服务端二次校验：结构 + 医疗红线 */
export function parsePlanDraft(args: unknown): PlanParseResult {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };

  const stageGoal = text(args.stageGoal, 200);
  if (!stageGoal) violations.push('stageGoal 必填且不超过 200 字');

  const rationale = text(args.foodTherapyRationale, 500);
  if (!rationale) violations.push('foodTherapyRationale 必填且不超过 500 字');

  const focusPoints = textList(args.focusPoints, 4, 40);
  if (!focusPoints || focusPoints.length < 2) violations.push('focusPoints 需 2–4 条短句');

  const feedbackRequirements = textList(args.feedbackRequirements, 3, 100) ?? [];

  const rawActions = args.actions;
  if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.length > 6) {
    violations.push('actions 需 1–6 条');
  }

  const actions: Array<{
    actionId: string;
    title: string;
    purpose: string;
    method: string;
    schedule: { kind: 'daily' | 'weekly' | 'oneoff'; time: string };
    feedbackKind: 'checkin' | 'record_meal' | 'record_review' | 'none';
    linkedArticleIds: string[];
  }> = [];

  if (Array.isArray(rawActions)) {
    rawActions.forEach((raw, index) => {
      if (!isRecord(raw)) {
        violations.push(`actions[${index}] 必须是对象`);
        return;
      }
      // 先清洗再量长度：模型常把「21:00 」写进标题，带前缀计长会把合法的动作判成超长
      const title = text(
        stripTimePrefix(typeof raw.title === 'string' ? raw.title.trim() : ''),
        30,
      );
      const purpose = text(raw.purpose, 60);
      const method = text(raw.method, 120);
      const schedule = isRecord(raw.schedule) ? raw.schedule : null;
      const kind = schedule?.kind;
      const time = typeof schedule?.time === 'string' ? schedule.time : '';
      const feedbackKind = raw.feedbackKind;

      if (!title) violations.push(`actions[${index}].title 必填且不超过 30 字`);
      if (!purpose) violations.push(`actions[${index}].purpose 必填且不超过 60 字`);
      if (!method) violations.push(`actions[${index}].method 必填且不超过 120 字`);
      if (kind !== 'daily' && kind !== 'weekly' && kind !== 'oneoff') {
        violations.push(`actions[${index}].schedule.kind 必须是 daily/weekly/oneoff`);
      }
      if (!/^\d{2}:\d{2}$/.test(time)) {
        violations.push(`actions[${index}].schedule.time 需为 HH:mm`);
      }
      if (
        feedbackKind !== 'checkin' &&
        feedbackKind !== 'record_meal' &&
        feedbackKind !== 'record_review' &&
        feedbackKind !== 'none'
      ) {
        violations.push(`actions[${index}].feedbackKind 非法`);
      }

      if (title && purpose && method && /^\d{2}:\d{2}$/.test(time)) {
        actions.push({
          actionId: `act_${index + 1}`,
          title,
          purpose,
          method,
          schedule: { kind: kind as 'daily' | 'weekly' | 'oneoff', time },
          feedbackKind: feedbackKind as 'checkin' | 'record_meal' | 'record_review' | 'none',
          linkedArticleIds: [],
        });
      }
    });
  }

  // 医疗红线：命中即整份退回，不让审核人替模型兜底
  const corpus = [
    stageGoal ?? '',
    rationale ?? '',
    ...(focusPoints ?? []),
    ...(Array.isArray(rawActions) ? rawActions.map((item) => JSON.stringify(item)) : []),
  ].join(' ');
  const hit = containsForbidden(corpus);
  if (hit) violations.push(`内容包含医疗行为词「${hit}」，不允许进入审核`);

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    draft: {
      stageGoal: stageGoal!,
      foodTherapyRationale: rationale!,
      focusPoints: focusPoints!,
      actions,
      feedbackRequirements,
    },
  };
}

// ---------- 生成端口 ----------

export interface LlmPlanGeneratorOptions {
  port: PlanChatPort;
  modelName?: string;
  promptVersion?: string;
  timeoutMs?: number;
}

export class LlmPlanGenerator {
  readonly configured: boolean;
  private readonly port: PlanChatPort;
  private readonly modelName?: string;
  private readonly promptVersion: string;
  private readonly timeoutMs: number;

  constructor(options: LlmPlanGeneratorOptions) {
    this.port = options.port;
    this.modelName = options.modelName;
    this.promptVersion = options.promptVersion ?? 'plan-v1';
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.configured = options.port.available;
  }

  async generate(input: {
    patientId: string;
    profile: Array<{ fieldKey: string; valueText: string }>;
    startDate: string;
    endDate: string;
  }): Promise<
    | {
        ok: true;
        draft: {
          stageGoal: string;
          foodTherapyRationale: string;
          focusPoints: string[];
          actions: Array<{
            actionId: string;
            title: string;
            purpose: string;
            method: string;
            schedule: { kind: 'daily' | 'weekly' | 'oneoff'; time: string };
            feedbackKind: 'checkin' | 'record_meal' | 'record_review' | 'none';
            linkedArticleIds: string[];
          }>;
          feedbackRequirements: string[];
          ruleRefs: Array<{ refType: string; refId: string; refVersion: number }>;
          model?: string;
          promptVersion?: string;
        };
      }
    | { ok: false; errorCode: string }
  > {
    if (!this.port.available) return { ok: false, errorCode: 'UPSTREAM_UNAVAILABLE' };

    const { systemPrompt, userPrompt } = buildPlanPrompts({
      startDate: input.startDate,
      endDate: input.endDate,
      profile: input.profile,
    });

    const result = await this.port.runTurn({
      patientId: input.patientId,
      systemPrompt,
      userPrompt,
      timeoutMs: this.timeoutMs,
    });
    if (result.error) return { ok: false, errorCode: result.error };

    const parsed = parsePlanDraft(result.toolArgs);
    if (!parsed.ok) return { ok: false, errorCode: 'INVALID_DRAFT' };

    return {
      ok: true,
      draft: {
        ...parsed.draft,
        ruleRefs: [],
        ...(this.modelName ? { model: this.modelName } : {}),
        promptVersion: this.promptVersion,
      },
    };
  }
}
