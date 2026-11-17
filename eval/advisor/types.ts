/**
 * 顾问 Agent 离线评测（#167 §13）的数据结构。
 *
 * 案例全部虚构。评测先离线（确定性驱动工具，校验数据整形 / 越权 / 原文照抄 /
 * 数据缺口不编造），真 DSH + 真模型的回合由项目负责人执行（⏳）。
 */
export type AdvisorEvalScope =
  | 'patient'
  | 'knowledge'
  | 'script'
  | 'alert'
  | 'rule'
  | 'draft'
  | 'promise';

export interface AdvisorEvalCase {
  id: string;
  /** 顾问发送的问题（评测里只作为上下文提示） */
  message: string;
  /** 期望模型调用的工具 */
  expectTool:
    | 'advisor_overview'
    | 'advisor_search'
    | 'advisor_get'
    | 'patient_chronic'
    | 'patient_meals'
    | 'patient_meal_photo'
    | 'draft_discard'
    | 'promise_resolve';
  expectArgs: {
    scope?: AdvisorEvalScope;
    query?: string;
    id?: string;
    patientId?: string;
    date?: string;
    mealType?: string;
    draftId?: string;
    promiseId?: string;
    outcome?: string;
  };
  /** 期望工具结果的 status */
  expectStatus: 'ok' | 'forbidden' | 'not-found' | 'unconnected';
  /** 渲染文本必须出现的内容 */
  requireText: string[];
  /** 渲染文本禁止出现的内容（越权数据、编造数值等） */
  forbidText: string[];
  /** 原文一致性：该条目 id 的返回内容必须与种子原文逐字相等 */
  verbatimId?: string;
}

export interface AdvisorEvalCheck {
  id: string;
  label: string;
  pass: boolean;
  detail?: string;
}

export interface AdvisorEvalResult {
  id: string;
  message: string;
  expectTool: string;
  pass: boolean;
  checks: AdvisorEvalCheck[];
  renderedText: string;
}
