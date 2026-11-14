/**
 * 侧边栏首屏视图（#147）。
 *
 * 把待回复索引、服务群绑定与患者档案拼成一次请求即可渲染的形状。
 * 纯函数式：不做 I/O、不读环境变量，便于直接测试权限与隐私规则。
 *
 * 权限：只有该会话的绑定顾问可以读取；昵称与档案只在具备
 * `patient.read` 时返回，否则为 null，不降级成「外部成员 xxx」。
 */
import type { ChronicProfile } from './chronic.ts';
import { CHRONIC_METRICS, latestMeasurements } from './chronic.ts';
import type { PendingItem } from './sidebar.ts';
import { dmConvKey, groupConvKey } from './sidebar.ts';

export interface SidebarAdvisor {
  id: string;
  name?: string;
  /** 企微 userid；单聊会话键需要，缺失时单聊按未接入返回 */
  wecomUserId?: string;
  permissions: string[];
}

export interface SidebarGroupRef {
  roomId: string;
  chatId?: string;
  name: string;
  advisorId?: string;
  status?: string;
}

export interface SidebarPatientRef {
  id: string;
  displayName: string;
  tags?: string[];
  consent?: string;
  identityStatus?: 'pending' | 'confirmed';
  lastActiveAt?: number;
  advisorId?: string;
  /** 建档 / 开始陪伴的时间，用于展示服务天数 */
  accompaniedSince?: number;
}

/** 已生成、尚未发出的草稿（只读引用，来自 zhiban-wecom 的草稿存储） */
export interface SidebarDraftRef {
  id: string;
  body: string;
  riskLevel: 'low' | 'medium' | 'high';
  ruleNames?: string[];
  createdAt: number;
  status: string;
  /** #163：回读核验结果；处理后在侧边栏展示，不再私聊回执 */
  verification?: { outcome: string; checkedAt: number };
}

export interface SidebarViewDeps {
  openItems(convKey: string): PendingItem[];
  recentlyClosed(convKey: string, limit?: number): PendingItem[];
  lastObservedAt(convKey: string): number | undefined;
  listGroups(): SidebarGroupRef[];
  /** 群里绑定的患者 id；未绑定时为空 */
  patientIdsForRoom?(roomId: string): string[];
  getPatient(id: string): SidebarPatientRef | undefined;
  /** 按外部成员 userid 找患者名；昵称门控在视图层做 */
  patientNameFor?(externalUserId: string): string | undefined;
  /** #159 按外部成员 userid 找患者档案；单聊速览用 */
  patientForExternal?(externalUserId: string): SidebarPatientRef | undefined;
  /** 慢病档案；没有录入过时返回 undefined，视图层转成 chronic: null */
  getChronic?(patientId: string): ChronicProfile | undefined;
  /** 患者绑定的服务群名，主群在前；未接线或查不到时返回空数组 */
  groupsForPatient?(patientId: string): string[];
  getAdvisorName?(advisorId: string): string | undefined;
  /** 该群在 since 之后生成、还没发出的草稿；没有则空 */
  latestDraft?(roomId: string, since: number): SidebarDraftRef | undefined;
  now?: () => number;
}

export interface SidebarQuery {
  chatId?: string;
  /** 单聊使用：企微 JS-SDK getCurExternalContact 拿到的外部联系人 id */
  externalUserId?: string;
  /** 仅供服务端内部与测试使用，不接受前端直接传 */
  roomId?: string;
}

export interface SidebarDraftView {
  id: string;
  body: string;
  riskLevel: 'low' | 'medium' | 'high';
  ruleNames: string[];
  createdAt: number;
  /** #163：核验中 / 已送达 / 未匹配；没有核验结果时不返回 */
  verification: { outcome: string; checkedAt: number } | null;
}

export interface SidebarPendingView {
  id: string;
  customerId: string;
  customerName: string | null;
  firstAt: number;
  lastAt: number;
  messageCount: number;
  excerpt: string;
  waitSeconds: number;
  reason: string;
  aiReplied: boolean;
  hasDraft: boolean;
  /** 已生成、未发出的草稿；只挂在会话里最新的一条上，避免同一份草稿重复出现 */
  draft: SidebarDraftView | null;
}

export interface SidebarClosedView {
  id: string;
  closedAt: number;
  closedBy: string | null;
}

/** 慢病档案里单个指标的最新值；label/unit 由服务端按指标表给出，前端不再维护一份 */
export interface SidebarChronicMeasurementView {
  metric: string;
  label: string;
  unit: string;
  value: number;
  /** 血压的舒张压，其他指标为 null */
  secondaryValue: number | null;
  /** 血糖的测量情境（空腹 / 餐后 2 小时…） */
  context: string | null;
  measuredAt: number;
  source: 'advisor' | 'agent';
}

export interface SidebarChronicMedicationView {
  name: string;
  dose: string | null;
  frequency: string | null;
}

export interface SidebarChronicView {
  conditions: string[];
  measurements: SidebarChronicMeasurementView[];
  medications: SidebarChronicMedicationView[];
  updatedAt: number;
}

/**
 * 客户速览固定带齐这些字段：前端的区块顺序与标题不随数据多少变化，
 * 缺数据时由前端显示「未打标签 / 尚未录入」等占位，而不是整块消失。
 */
export interface SidebarProfileView {
  bound: boolean;
  name: string | null;
  confirmed: boolean;
  tags: string[];
  /** 存档同意状态（agreed / unknown / disagreed）；无档案时为 null */
  consent: string | null;
  /** 已服务天数；无档案或缺少建档时间时为 null */
  servedDays: number | null;
  /** 已绑定的服务群名（主群在前）；无权限或无档案时为 [] */
  groups: string[];
  /** 慢病档案摘要；没有档案或未授权时为 null，前端仍保留区块并显示「尚未录入」 */
  chronic: SidebarChronicView | null;
  carePlan: null;
  silentDays: number | null;
  advisorName: string | null;
}

export interface SidebarContextView {
  conv: {
    kind: 'group' | 'dm';
    key: string | null;
    name: string | null;
    served: boolean;
    /** 未接入的原因，可直接展示给顾问 */
    reason?: 'GROUP_NOT_FOUND' | 'DM_NOT_SUPPORTED' | 'NOT_BOUND';
    lastObservedAt: number | null;
  };
  pending: {
    open: SidebarPendingView[];
    recentlyClosed: SidebarClosedView[];
    openCount: number;
    oldestWaitSeconds: number | null;
  };
  profile: SidebarProfileView | null;
  generatedAt: number;
}

export type SidebarAccessCode = 'UNAUTHENTICATED' | 'FORBIDDEN';

export class SidebarAccessError extends Error {
  readonly code: SidebarAccessCode;

  constructor(code: SidebarAccessCode, message: string) {
    super(message);
    this.name = 'SidebarAccessError';
    this.code = code;
  }
}

const DAY_MS = 24 * 60 * 60_000;

export function buildSidebarContext(
  deps: SidebarViewDeps,
  advisor: SidebarAdvisor | undefined,
  query: SidebarQuery,
): SidebarContextView {
  if (!advisor) throw new SidebarAccessError('UNAUTHENTICATED', '未登录或登录已失效');
  const now = deps.now?.() ?? Date.now();

  if (!query.chatId && !query.roomId) {
    const externalUserId = query.externalUserId;
    const staffUserId = advisor.wecomUserId;
    // 单聊会话键用登录顾问自己的企微 userid 构造：天然只能查到自己的会话。
    // 任一标识缺失就按未接入返回，不猜键。
    if (!externalUserId || !staffUserId) {
      return dmNotSupported(now);
    }
    const convKey = dmConvKey(staffUserId, externalUserId);
    const canRead = advisor.permissions.includes('patient.read');
    const patient = deps.patientForExternal?.(externalUserId);
    const open = pendingViews(deps.openItems(convKey), canRead, now, deps, undefined, null);
    return {
      conv: {
        kind: 'dm',
        key: convKey,
        name: canRead ? (patient?.displayName ?? null) : null,
        served: true,
        lastObservedAt: deps.lastObservedAt(convKey) ?? null,
      },
      pending: {
        open,
        recentlyClosed: deps.recentlyClosed(convKey, 5).map(toClosedView),
        openCount: open.length,
        oldestWaitSeconds: maxWaitSeconds(open),
      },
      profile: profileView(
        patient,
        canRead,
        now,
        canRead ? (deps.getAdvisorName?.(advisor.id) ?? null) : null,
        canRead && patient ? deps.getChronic?.(patient.id) : undefined,
        patient ? (deps.groupsForPatient?.(patient.id) ?? []) : [],
      ),
      generatedAt: now,
    };
  }

  // 客户群的 roomId 与 chatId 是同一个 wr… ID；旧档案可能只填了其一，
  // 两个键都参与匹配，避免侧边栏拿 chatId 查不到只有 roomId 的群档案。
  const group = deps
    .listGroups()
    .find((item) =>
      query.roomId
        ? item.roomId === query.roomId || item.chatId === query.roomId
        : item.chatId === query.chatId || item.roomId === query.chatId,
    );

  if (!group) {
    return {
      conv: {
        kind: 'group',
        key: query.roomId ? groupConvKey(query.roomId) : null,
        name: null,
        served: false,
        reason: 'GROUP_NOT_FOUND',
        lastObservedAt: null,
      },
      pending: { open: [], recentlyClosed: [], openCount: 0, oldestWaitSeconds: null },
      profile: null,
      generatedAt: now,
    };
  }

  if (group.advisorId !== advisor.id) {
    throw new SidebarAccessError('FORBIDDEN', '不在该会话的服务范围内');
  }

  const convKey = groupConvKey(group.roomId);
  const canRead = advisor.permissions.includes('patient.read');
  const items = deps.openItems(convKey);

  // 草稿只挂一次：放在会话里最新的一条上。较早的条目只是还没清理，
  // 同一份草稿在每个条目下重复出现反而干扰判断。
  const newest = items.reduce<PendingItem | undefined>(
    (latest, item) => (!latest || item.lastAt > latest.lastAt ? item : latest),
    undefined,
  );
  const draftRef = newest && deps.latestDraft
    ? deps.latestDraft(group.roomId, newest.firstAt)
    : undefined;
  const draft: SidebarDraftView | null = draftRef
    ? {
        id: draftRef.id,
        body: draftRef.body,
        riskLevel: draftRef.riskLevel,
        ruleNames: [...(draftRef.ruleNames ?? [])],
        createdAt: draftRef.createdAt,
        verification: draftRef.verification
          ? {
              outcome: draftRef.verification.outcome,
              checkedAt: draftRef.verification.checkedAt,
            }
          : null,
      }
    : null;

  const open: SidebarPendingView[] = pendingViews(items, canRead, now, deps, newest?.id, draft);

  const oldest = maxWaitSeconds(open);

  const closed: SidebarClosedView[] = deps.recentlyClosed(convKey, 5).map(toClosedView);

  const patientId = deps.patientIdsForRoom?.(group.roomId)?.[0];
  const patient = patientId ? deps.getPatient(patientId) : undefined;

  const profile: SidebarProfileView | null = profileView(
    patient,
    canRead,
    now,
    canRead ? (group.advisorId ? (deps.getAdvisorName?.(group.advisorId) ?? null) : null) : null,
    canRead && patient ? deps.getChronic?.(patient.id) : undefined,
    patient ? (deps.groupsForPatient?.(patient.id) ?? []) : [],
  );

  return {
    conv: {
      kind: 'group',
      key: convKey,
      name: canRead ? group.name : null,
      served: true,
      lastObservedAt: deps.lastObservedAt(convKey) ?? null,
    },
    pending: {
      open,
      recentlyClosed: closed,
      openCount: open.length,
      oldestWaitSeconds: oldest,
    },
    profile,
    generatedAt: now,
  };
}

/** 单聊链路不可用（缺外部 id 或顾问没有企微 userid）时的兜底返回 */
function dmNotSupported(now: number): SidebarContextView {
  return {
    conv: {
      kind: 'dm',
      key: null,
      name: null,
      served: false,
      reason: 'DM_NOT_SUPPORTED',
      lastObservedAt: null,
    },
    pending: { open: [], recentlyClosed: [], openCount: 0, oldestWaitSeconds: null },
    profile: null,
    generatedAt: now,
  };
}

function waitSeconds(item: PendingItem, now: number): number {
  return Math.max(0, Math.floor((now - item.lastAt) / 1000));
}

function toClosedView(item: PendingItem): SidebarClosedView {
  return {
    id: item.id,
    closedAt: item.closedAt ?? item.lastAt,
    closedBy: item.closedBy ?? null,
  };
}

function maxWaitSeconds(open: SidebarPendingView[]): number | null {
  return open.reduce<number | null>(
    (max, item) => (max === null ? item.waitSeconds : Math.max(max, item.waitSeconds)),
    null,
  );
}

/** 群与单聊共用的待回复视图映射；单聊没有草稿，draft 传 null */
function pendingViews(
  items: PendingItem[],
  canRead: boolean,
  now: number,
  deps: SidebarViewDeps,
  newestId: string | undefined,
  draft: SidebarDraftView | null,
): SidebarPendingView[] {
  return items.map((item) => ({
    id: item.id,
    customerId: item.customerId,
    customerName: canRead ? (deps.patientNameFor?.(item.customerId) ?? null) : null,
    firstAt: item.firstAt,
    lastAt: item.lastAt,
    messageCount: item.messageCount,
    excerpt: item.excerpt,
    waitSeconds: waitSeconds(item, now),
    reason: item.reason,
    aiReplied: item.botRepliedAt !== undefined,
    hasDraft: item.id === newestId && draft !== null,
    draft: item.id === newestId ? draft : null,
  }));
}

/** 群与单聊共用的速览视图；patient 缺省时返回「未绑定」形状 */
function profileView(
  patient: SidebarPatientRef | undefined,
  canRead: boolean,
  now: number,
  advisorName: string | null,
  chronic?: ChronicProfile,
  groups: string[] = [],
): SidebarProfileView {
  if (!patient) {
    return {
      bound: false,
      name: null,
      confirmed: false,
      tags: [],
      consent: null,
      servedDays: null,
      groups: [],
      chronic: null,
      carePlan: null,
      silentDays: null,
      advisorName: null,
    };
  }
  const accompaniedSince = patient.accompaniedSince;
  return {
    bound: true,
    name: canRead ? patient.displayName : null,
    confirmed: patient.identityStatus === 'confirmed',
    tags: canRead ? [...(patient.tags ?? [])] : [],
    consent: canRead ? (patient.consent ?? 'unknown') : null,
    servedDays:
      !canRead || accompaniedSince === undefined
        ? null
        : Math.max(0, Math.floor((now - accompaniedSince) / DAY_MS)),
    groups: canRead ? [...groups] : [],
    chronic: canRead ? chronicView(chronic) : null,
    carePlan: null,
    silentDays:
      !canRead || patient.lastActiveAt === undefined
        ? null
        : Math.max(0, Math.floor((now - patient.lastActiveAt) / DAY_MS)),
    advisorName: canRead ? advisorName : null,
  };
}

/** 侧边栏只放得下最近几条，指标按测量时间取最新的 3 个 */
const SIDEBAR_CHRONIC_METRIC_LIMIT = 3;
const SIDEBAR_MEDICATION_LIMIT = 3;

/**
 * 慢病档案摘要：每个指标只取最新一条，按测量时间倒序截断。
 * 条件与用药是清单，档案为空时整块返回 null，让前端隐藏而不是显示空壳。
 */
function chronicView(profile: ChronicProfile | undefined): SidebarChronicView | null {
  if (!profile) return null;
  if (
    profile.conditions.length === 0 &&
    profile.medications.length === 0 &&
    profile.measurements.length === 0
  ) {
    return null;
  }

  const measurements = [...latestMeasurements(profile).entries()]
    .sort(([, a], [, b]) => b.measuredAt - a.measuredAt)
    .slice(0, SIDEBAR_CHRONIC_METRIC_LIMIT)
    .map(([metric, measurement]) => ({
      metric,
      label: CHRONIC_METRICS[metric].label,
      unit: CHRONIC_METRICS[metric].unit,
      value: measurement.value,
      secondaryValue: measurement.secondaryValue ?? null,
      context: measurement.context ?? null,
      measuredAt: measurement.measuredAt,
      source: measurement.source,
    }));

  return {
    conditions: [...profile.conditions],
    measurements,
    medications: profile.medications
      .slice(0, SIDEBAR_MEDICATION_LIMIT)
      .map((medication) => ({
        name: medication.name,
        dose: medication.dose ?? null,
        frequency: medication.frequency ?? null,
      })),
    updatedAt: profile.updatedAt,
  };
}
