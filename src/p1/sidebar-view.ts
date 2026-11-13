/**
 * 侧边栏首屏视图（#147）。
 *
 * 把待回复索引、服务群绑定与患者档案拼成一次请求即可渲染的形状。
 * 纯函数式：不做 I/O、不读环境变量，便于直接测试权限与隐私规则。
 *
 * 权限：只有该会话的绑定顾问可以读取；昵称与档案只在具备
 * `patient.read` 时返回，否则为 null，不降级成「外部成员 xxx」。
 */
import type { PendingItem } from './sidebar.ts';
import { groupConvKey } from './sidebar.ts';

export interface SidebarAdvisor {
  id: string;
  name?: string;
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
  getAdvisorName?(advisorId: string): string | undefined;
  now?: () => number;
}

export interface SidebarQuery {
  chatId?: string;
  /** 单聊使用；当前存档链路未覆盖，返回未接入 */
  externalUserId?: string;
  /** 仅供服务端内部与测试使用，不接受前端直接传 */
  roomId?: string;
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
}

export interface SidebarClosedView {
  id: string;
  closedAt: number;
  closedBy: string | null;
}

export interface SidebarProfileView {
  bound: boolean;
  name: string | null;
  confirmed: boolean;
  tags: string[];
  /** 慢性档案在另一个未合并分支，先返回 null，避免假装有数据 */
  chronic: null;
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

  const group = deps
    .listGroups()
    .find((item) =>
      query.roomId ? item.roomId === query.roomId : item.chatId === query.chatId,
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

  const open: SidebarPendingView[] = items.map((item) => ({
    id: item.id,
    customerId: item.customerId,
    customerName: canRead ? deps.patientNameFor?.(item.customerId) ?? null : null,
    firstAt: item.firstAt,
    lastAt: item.lastAt,
    messageCount: item.messageCount,
    excerpt: item.excerpt,
    waitSeconds: Math.max(0, Math.floor((now - item.lastAt) / 1000)),
    reason: item.reason,
    aiReplied: item.botRepliedAt !== undefined,
    hasDraft: false,
  }));

  const oldest = open.reduce<number | null>(
    (max, item) => (max === null ? item.waitSeconds : Math.max(max, item.waitSeconds)),
    null,
  );

  const closed: SidebarClosedView[] = deps.recentlyClosed(convKey, 5).map((item) => ({
    id: item.id,
    closedAt: item.closedAt ?? item.lastAt,
    closedBy: item.closedBy ?? null,
  }));

  const patientId = deps.patientIdsForRoom?.(group.roomId)?.[0];
  const patient = patientId ? deps.getPatient(patientId) : undefined;

  const profile: SidebarProfileView | null = patient
    ? {
        bound: true,
        name: canRead ? patient.displayName : null,
        confirmed: patient.identityStatus === 'confirmed',
        tags: canRead ? [...(patient.tags ?? [])] : [],
        chronic: null,
        carePlan: null,
        silentDays:
          patient.lastActiveAt === undefined
            ? null
            : Math.max(0, Math.floor((now - patient.lastActiveAt) / DAY_MS)),
        advisorName: canRead
          ? (group.advisorId ? deps.getAdvisorName?.(group.advisorId) ?? null : null)
          : null,
      }
    : {
        bound: false,
        name: null,
        confirmed: false,
        tags: [],
        chronic: null,
        carePlan: null,
        silentDays: null,
        advisorName: null,
      };

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
