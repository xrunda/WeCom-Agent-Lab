/**
 * P1 顾问 Agent（#167）的领域类型。
 *
 * 工具是唯一的数据入口：身份从会话 id 解析，工具参数里没有 advisorId。
 * 本模块只放类型与常量，不依赖 DSH，便于离线单测与评测。
 */
import type { RiskLevel } from '../../c2/types.ts';

// ---------- 只读数据端口 ----------

/** 待办里的未完成草稿视图；正文只在 get 草稿详情时返回 */
export interface AdvisorDraftView {
  id: string;
  groupName: string;
  riskLevel: RiskLevel;
  status: string;
  /** 进入当前状态的时间，用来算已等多久 */
  since: number;
  version?: number;
}

export interface AdvisorPromiseView {
  groupName: string;
  dueAt: number;
  dueLabel: string;
}

export interface AdvisorAlertView {
  id: string;
  title: string;
  at: number;
  severity?: string;
  ruleIds?: string[];
}

export interface AdvisorActiveDraftView {
  id: string;
  groupName: string;
  riskLevel: RiskLevel;
  status: string;
  version?: number;
}

/**
 * zhiban-wecom 提供的 `zhibanAdvisorData` 只读端口。
 * 全部按 advisorId 过滤：草稿 / 承诺 / 告警只返回该顾问名下。
 */
export interface AdvisorWecomDataPort {
  advisorName(advisorId: string): string | undefined;
  draftsFor(advisorId: string): AdvisorDraftView[];
  promisesFor(advisorId: string): AdvisorPromiseView[];
  alertsFor(advisorId: string): AdvisorAlertView[];
  /** 待回复会话数；侧边栏未接入时为 undefined，不能把「没接入」当「0」 */
  pendingRepliesFor?(advisorId: string): number | undefined;
  activeDraftFor(advisorId: string): AdvisorActiveDraftView | undefined;
  /** 给顾问本人 1:1 发消息；返回是否送达 */
  sendText(advisorId: string, text: string): Promise<boolean>;
  /**
   * 给顾问本人补发一张图片（饮食记录原图）。
   * path 是服务端媒体路径，只在插件内部传递，不进工具结果、不进日志。
   */
  sendImage?(advisorId: string, path: string): Promise<boolean>;
  /** 客户昵称权限：false 时工具只返回患者 id 尾号 */
  canReadPatient: boolean;
}

// ---------- 工具结果 ----------

/** 待办快照：命令路径与 advisor_overview 工具共用 */
export interface TodoSnapshot {
  drafts: AdvisorDraftView[];
  promises: AdvisorPromiseView[];
  alerts: AdvisorAlertView[];
  /** 待回复会话数；undefined = 数据源未接入，输出里不出现这一行 */
  pendingReplies?: number;
  now: number;
}

export interface AdvisorOverviewResult {
  snapshot: TodoSnapshot;
}

export type AdvisorSearchScope = 'patient' | 'knowledge' | 'script' | 'alert';
export type AdvisorGetScope = AdvisorSearchScope | 'rule';

/** search / get 里的单条命中；知识 / 话术 / 规则必须携带机构原文 */
export interface AdvisorHitItem {
  id: string;
  title: string;
  category?: string;
  /** 原文：知识 / 话术 / 规则返回机构原文；患者 / 告警为展示文本 */
  content?: string;
  tags?: string[];
  at?: number;
  severity?: string;
  ruleIds?: string[];
}

export type AdvisorSearchResult =
  | { status: 'ok'; scope: AdvisorSearchScope; query: string; found: number; items: AdvisorHitItem[] }
  | { status: 'unconnected'; scope: AdvisorSearchScope };

export type AdvisorGetResult =
  | { status: 'ok'; scope: AdvisorGetScope; id: string; item: AdvisorHitItem }
  | { status: 'unconnected'; scope: AdvisorGetScope }
  | { status: 'not-found'; scope: AdvisorGetScope; id: string }
  | { status: 'forbidden' };

export type AdvisorChronicResult =
  | { status: 'unconnected' }
  | {
      status: 'ok';
      patientId: string;
      /** 是否真的有档案；空档案必须如实回「无记录」，不能靠模型发挥 */
      hasRecord: boolean;
      displayName: string;
      conditions: string[];
      medications: string[];
      /** 最近 3 条体征的展示文本（指标 + 数值 + 时间） */
      recentMeasurements: string[];
      updatedAt?: number;
      /**
       * 患者事实卡（#167）：疾病 / 身高体重 / 用药 / 最近体征 / 最近饮食 / 长期记忆。
       * 有它就优先渲染；为空时回退到上面的结构化字段。
       */
      facts?: string[];
    }
  | { status: 'forbidden' };

/** 一条饮食记录的精简视图；不带图片路径与存档 id */
export interface AdvisorMealItem {
  mealType: string;
  /** 展示用时间（上海） */
  time: string;
  foods: string[];
  notes?: string;
  agentComment?: string;
  confidence: number;
}

export type AdvisorMealsResult =
  | { status: 'unconnected' }
  | {
      status: 'ok';
      patientId: string;
      displayName: string;
      /** 查询的日期（YYYY-MM-DD，上海时区） */
      date: string;
      hasRecord: boolean;
      meals: AdvisorMealItem[];
    }
  | { status: 'forbidden' }
  | { status: 'not-found' };

// ---------- 会话 ----------

export interface AdvisorSessionRecord {
  advisorId: string;
  sessionId: string;
  workspacePath: string;
  createdAt: number;
}
