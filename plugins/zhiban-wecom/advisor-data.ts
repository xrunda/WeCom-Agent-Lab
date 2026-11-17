/**
 * `zhibanAdvisorData` 只读端口（#167 §3.1）。
 *
 * 把草稿 / 承诺 / 告警 / 待回复 / 发消息按 advisorId 过滤后交给 zhiban-advisor。
 * 数据全部来自 zhiban-wecom 自己的领域存储 + zhiban-guard 告警 + zhiban-sidebar
 * 待回复索引；只读，不产生任何写操作。日志由调用方按尾号记录。
 */
import type {
  AdvisorActiveDraftView,
  AdvisorAlertView,
  AdvisorDraftDetail,
  AdvisorDraftView,
  AdvisorPendingReplyItem,
  AdvisorPromiseDetail,
  AdvisorPromiseView,
  AdvisorWecomDataPort,
} from '../../src/p1/advisor/types.ts';
import type { Draft } from '../../src/c2/types.ts';
import type { PromiseRecord } from '../../src/c2/promises.ts';

export interface AdvisorWecomDataDeps {
  listDrafts(): Draft[];
  listPromises(): PromiseRecord[];
  listGroups(): Array<{ roomId: string; advisorId?: string }>;
  getAdvisor(id: string): { name: string; chatId?: string } | undefined;
  getActiveDraft(advisorId: string): string | undefined;
  getDraft(id: string): Draft | undefined;
  /** 承诺详情；不存在返回 undefined */
  getPromise?(id: string): PromiseRecord | undefined;
  /** 未处理告警：guard 未安装时返回空 */
  openAlerts(advisorId: string): AdvisorAlertView[];
  /** 待回复索引：侧边栏未安装时返回 undefined */
  openPendingCount?(advisorId: string): number | undefined;
  /** 待回复会话清单：侧边栏未安装时返回 undefined */
  openPendingItems?(advisorId: string): AdvisorPendingReplyItem[] | undefined;
  sendText(chatId: string, text: string): Promise<void>;
  /** 补发饮食记录原图；机器人不支持发图时可不提供 */
  sendImage?(chatId: string, path: string): Promise<void>;
  /** 作废一条草稿（侧边栏「跳过」同一状态机）；状态不允许时抛错 */
  discardDraft?(draftId: string, actor: string): Promise<void>;
  /** 处理承诺：done / dismissed；非 pending 时抛错 */
  resolvePromise?(promiseId: string, action: 'done' | 'dismissed', actor: string): Promise<void>;
  canReadPatient: boolean;
}

function draftView(draft: Draft): AdvisorDraftView {
  return {
    id: draft.id,
    groupName: draft.groupName,
    riskLevel: draft.riskLevel,
    status: draft.status,
    since: draft.pushedAt ?? draft.queuedAt ?? draft.createdAt,
    ...(draft.version !== undefined ? { version: draft.version } : {}),
  };
}

export function buildAdvisorWecomData(deps: AdvisorWecomDataDeps): AdvisorWecomDataPort {
  const chatIdFor = (advisorId: string): string | undefined =>
    deps.getAdvisor(advisorId)?.chatId ?? advisorId;

  return {
    advisorName: (advisorId) => deps.getAdvisor(advisorId)?.name,
    draftsFor: (advisorId) =>
      deps
        .listDrafts()
        .filter((draft) => draft.advisorId === advisorId)
        .map(draftView),
    promisesFor: (advisorId) =>
      deps
        .listPromises()
        .filter((promise) => promise.advisorId === advisorId && promise.status === 'pending')
        .map((promise) => ({
          id: promise.id,
          groupName: promise.groupName,
          excerpt: promise.excerpt,
          dueAt: promise.dueAt,
          dueLabel: promise.dueLabel,
        })),
    alertsFor: (advisorId) => deps.openAlerts(advisorId),
    pendingRepliesFor: deps.openPendingCount,
    activeDraftFor: (advisorId) => {
      const id = deps.getActiveDraft(advisorId);
      if (!id) return undefined;
      const draft = deps.getDraft(id);
      if (!draft) return undefined;
      const view: AdvisorActiveDraftView = {
        id: draft.id,
        groupName: draft.groupName,
        riskLevel: draft.riskLevel,
        status: draft.status,
        ...(draft.version !== undefined ? { version: draft.version } : {}),
      };
      return view;
    },
    sendText: async (advisorId, text) => {
      const chatId = chatIdFor(advisorId);
      if (!chatId) return false;
      try {
        await deps.sendText(chatId, text);
        return true;
      } catch {
        return false;
      }
    },
    sendImage: async (advisorId, path) => {
      const chatId = chatIdFor(advisorId);
      if (!chatId || !deps.sendImage) return false;
      try {
        await deps.sendImage(chatId, path);
        return true;
      } catch {
        return false;
      }
    },
    canReadPatient: deps.canReadPatient,
    pendingReplies: (advisorId) => deps.openPendingItems?.(advisorId) ?? undefined,
    draftDetail: (advisorId, draftId) => {
      const draft = deps.getDraft(draftId);
      if (!draft || draft.advisorId !== advisorId) return undefined;
      const detail: AdvisorDraftDetail = {
        id: draft.id,
        groupName: draft.groupName,
        riskLevel: draft.riskLevel,
        status: draft.status,
        body: draft.body,
        since: draft.pushedAt ?? draft.queuedAt ?? draft.createdAt,
      };
      if (draft.version !== undefined) detail.version = draft.version;
      return detail;
    },
    promiseDetail: (advisorId, promiseId) => {
      const record = deps.getPromise?.(promiseId);
      if (!record || record.advisorId !== advisorId) return undefined;
      const detail: AdvisorPromiseDetail = {
        id: record.id,
        groupName: record.groupName,
        excerpt: record.excerpt,
        dueAt: record.dueAt,
        dueLabel: record.dueLabel,
        status: record.status,
        remindCount: record.remindCount,
      };
      if (record.customerName && deps.canReadPatient) detail.customerName = record.customerName;
      return detail;
    },
    discardDraft: async (advisorId, draftId) => {
      if (!deps.discardDraft) return false;
      const draft = deps.getDraft(draftId);
      if (!draft || draft.advisorId !== advisorId) return false;
      try {
        await deps.discardDraft(draftId, advisorId);
        return true;
      } catch {
        return false;
      }
    },
    resolvePromise: async (advisorId, promiseId, action) => {
      if (!deps.resolvePromise) return false;
      const record = deps.getPromise?.(promiseId);
      if (!record || record.advisorId !== advisorId) return false;
      try {
        await deps.resolvePromise(promiseId, action, advisorId);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 待回复会话数：侧边栏 `allItems()` 里 open 的条目，
 * 匹配该顾问的服务群（room:）与其 1:1（dm:<userid>:）。
 * 侧边栏未接入时返回 undefined，不能把「没接入」当成「0」。
 */
export function pendingRepliesFromSidebar(input: {
  advisorId: string;
  groupRoomIds: Set<string>;
  allItems: () => Array<{ convKey: string; status: string }>;
}): number | undefined {
  const open = input.allItems().filter((item) => item.status === 'open');
  return open.filter(
    (item) =>
      item.convKey.startsWith(`dm:${input.advisorId}:`) ||
      (item.convKey.startsWith('room:') && input.groupRoomIds.has(item.convKey.slice(5))),
  ).length;
}

/** 待回复会话清单（逐条带客户原文摘要）；匹配逻辑与计数一致 */
export function pendingItemsFromSidebar(input: {
  advisorId: string;
  groupRoomIds: Set<string>;
  allItems: () => Array<{
    convKey: string;
    status: string;
    customerId: string;
    excerpt: string;
    reason: string;
    lastAt: number;
  }>;
}): AdvisorPendingReplyItem[] {
  const open = input.allItems().filter((item) => item.status === 'open');
  return open
    .filter(
      (item) =>
        item.convKey.startsWith(`dm:${input.advisorId}:`) ||
        (item.convKey.startsWith('room:') && input.groupRoomIds.has(item.convKey.slice(5))),
    )
    .map((item) => ({
      convKey: item.convKey,
      customerId: item.customerId,
      excerpt: item.excerpt,
      reason: item.reason,
      lastAt: item.lastAt,
    }));
}
