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
  AdvisorDraftView,
  AdvisorPromiseView,
  AdvisorWecomDataPort,
} from '../../src/p1/advisor/types.ts';
import type { Draft } from '../../src/c2/types.ts';

export interface AdvisorWecomDataDeps {
  listDrafts(): Draft[];
  listPromises(): Array<{
    advisorId: string;
    groupName: string;
    dueAt: number;
    dueLabel: string;
    status: string;
  }>;
  listGroups(): Array<{ roomId: string; advisorId?: string }>;
  getAdvisor(id: string): { name: string; chatId?: string } | undefined;
  getActiveDraft(advisorId: string): string | undefined;
  getDraft(id: string): Draft | undefined;
  /** 未处理告警：guard 未安装时返回空 */
  openAlerts(advisorId: string): AdvisorAlertView[];
  /** 待回复索引：侧边栏未安装时返回 undefined */
  openPendingCount?(advisorId: string): number | undefined;
  sendText(chatId: string, text: string): Promise<void>;
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
          groupName: promise.groupName,
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
    canReadPatient: deps.canReadPatient,
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
