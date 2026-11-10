/**
 * #64 草稿质量评测集的数据结构。
 *
 * 案例全部虚构，不包含真实患者、机构或凭据。
 */

export type CaseCategory =
  | 'diet'
  | 'sleep'
  | 'exercise'
  | 'emotion'
  | 'medication'
  | 'emergency'
  | 'family'
  | 'chat'
  | 'vague'
  | 'tricky'
  | 'image_meal'
  | 'image_report'
  | 'image_medicine'
  | 'image_other';

export interface EvalCaseBase {
  id: string;
  category: CaseCategory;
  /** 患者在沙盒里说的一句话 */
  message: string;
  /** 期望 Agent 记住的前提；为空表示无前提 */
  memoryPremise?: string[];
  /** 建立记忆用的自然患者发言；没有它时前提只作为评审参考 */
  setupMessage?: string;
  /** 评分要点，交给模型评审 */
  expectedPoints: string[];
  /** 正文中绝对不能出现的内容 */
  forbidden: string[];
  /** 正文长度上限，默认 150 字 */
  maxChars?: number;
  /** 正文至少出现其中一个词 */
  requireAny?: string[];
}

export interface TextEvalCase extends EvalCaseBase {
  kind: 'text';
}

export interface ImageEvalCase extends EvalCaseBase {
  kind: 'image';
  /** 相对 eval/drafts 的文件名 */
  image: string;
  imageKind: 'meal' | 'report' | 'medicine' | 'other';
  /** 餐食图期望识别出的主要食物 */
  expectedFoods?: string[];
}

export type EvalCase = TextEvalCase | ImageEvalCase;

export interface RuleCheck {
  id: string;
  label: string;
  pass: boolean;
  detail?: string;
}

export interface RuleResult {
  pass: boolean;
  violations: string[];
  checks: RuleCheck[];
}

export interface JudgeDimensions {
  professional: number;
  redline: number;
  memory: number;
  tone: number;
  length: number;
  sendable: number;
  imageRecognition?: number;
}

export interface JudgeResult {
  pass: boolean;
  score: number;
  dimensions: JudgeDimensions;
  reasons: string;
  recognizedFoods?: string[];
  interpretedIndicators?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CaseResult {
  case: EvalCase;
  draftId?: string;
  body?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  fallback?: boolean;
  mediaKinds?: string[];
  latencyMs?: number;
  rule?: RuleResult;
  judge?: JudgeResult;
  judgeError?: string;
  error?: string;
  memorySeeded?: boolean;
}
