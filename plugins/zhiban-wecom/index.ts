/**
 * zhiban-wecom DSH 插件入口（#32 / #54 / #65）。
 *
 * 生命周期全部挂在 `ctx.effect` 上：
 *   打开领域存储 → 恢复 seq / 停机判定 → 建档顾问与群 → 连接机器人 →
 *   启动存档轮询与串行队列 → 卸载时停轮询、落盘、关闭领域。
 *
 * 本文件只做装配；业务逻辑在 src/c2（可离线测试），
 * 存储实现在 ./domain.ts，轮询编排在 ./runtime.ts。
 */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import {
  WeComArchiveAdapter,
  isExternalCustomerId,
} from '../../src/c2/adapters/wecom-archive.ts';
import { WeComBotAdapter } from '../../src/c2/adapters/wecom-bot.ts';
import { tailId } from '../../src/c2/redact.ts';
import { C2Service } from '../../src/c2/service.ts';
import { tencentAsrFromEnv } from '../../src/c2/tencent-asr.ts';
import { ArchiveTrigger } from '../../src/c2/trigger.ts';
import type { ArchivePort } from '../../src/c2/ports.ts';
import type {
  Alert,
  ArchivedInbound,
  Draft,
  DraftRevision,
  VerifyOutcome,
} from '../../src/c2/types.ts';
import type { PatientBridge } from '../../src/p1/session-port.ts';
import type { SidebarSink } from '../../src/p1/sidebar.ts';
import type { InboundMessage as PatientInboundMessage, RouteDecision } from '../../src/p1/types.ts';

import { parsePluginConfig } from './config.ts';
import { AdvisorStatusService } from './advisor-status.ts';
import { DomainStore, DomainStoreBackend, wecomDomain } from './domain.ts';
import { GroupDiscovery } from './group-discovery.ts';
import { GroupInfoClient } from './group-info.ts';
import { RoomAgreeClient } from './room-agree.ts';
import { makeTemplateCompose, WecomRuntime } from './runtime.ts';
import type { PatientSink } from './runtime.ts';
import { ScriptQueryService, splitForWecom } from './script-query.ts';
import type { QueryableScript } from './script-query.ts';
import { KnowledgeQueryService } from './knowledge-query.ts';
import { PatrolService } from './patrol-service.ts';
import { PromiseService } from '../../src/c2/promise-service.ts';
import { ServiceGroupRegistry, reconcileServiceGroups } from './service-groups.ts';

export const name = 'zhiban-wecom';

/** storage-domain 由 dsh-storage-domain 插件提供 */
export const inject = ['storageDomain'];

type EffectCleanup = void | (() => void | Promise<void>);

/** 只声明本插件用到的 DSH Context 能力，避免依赖未随包发布的 dsh 类型 */
export interface DshPluginContext {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => EffectCleanup | Promise<EffectCleanup>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  get<T = unknown>(name: string): T | undefined;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
}

/** 重启后从已有草稿的最大序号继续 */
export function maxDraftSeq(drafts: Draft[]): number {
  let max = 0;
  for (const draft of drafts) {
    const match = /^draft_(\d+)$/.exec(draft.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** 只依赖 zhiban-patient 的语义复核入口；未安装时退回纯关键词告警 */
interface StaffJudgeApi {
  judgeStaffMessage?(input: {
    text: string;
    ruleNames: string[];
  }): Promise<'violation' | 'ok' | 'unknown'>;
}

/** 只依赖 zhiban-guard 的质检入口；未安装 guard 时静默跳过 */
interface StaffQualityGuard {
  /** 关键词初筛：不产生告警 */
  checkStaffMessage?(input: {
    text: string;
    advisorId?: string;
    advisorName?: string;
    groupId?: string;
    groupName?: string;
    messageId?: string;
  }): {
    hits: string[];
    hitNames: string[];
    riskLevel: string;
  };
  /** 语义复核判定不违规时留痕：不产生告警 */
  dismissStaffMessage?(input: {
    ruleIds: string[];
    advisorId?: string;
    groupId?: string;
    messageId?: string;
  }): void;
  reviewStaffMessage?(input: {
    text: string;
    advisorId?: string;
    advisorName?: string;
    groupId?: string;
    groupName?: string;
    messageId?: string;
  }): {
    hits: string[];
    hitNames: string[];
    riskLevel: string;
    alertId?: string;
  };
  /** 「为什么红线」用：只读规则名与关键词，不读发言正文 */
  getRule?(id: string): { name: string; keywords: string[] } | undefined;
  alerts?(): Array<{
    kind: string;
    status?: string;
    source?: string;
    advisorId?: string;
    ruleIds: string[];
    createdAt: number;
  }>;
}

export type StaffQualityOutcome = 'clean' | 'alerted' | 'dismissed';

export interface StaffQualityDecisionDeps {
  /** 关键词初筛；guard 没提供时返回 undefined */
  precheck?(): { hits: string[]; hitNames: string[] } | undefined;
  /** 语义复核；不可用时直接告警 */
  judge?(input: { text: string; ruleNames: string[] }): Promise<'violation' | 'ok' | 'unknown'>;
  raiseAlert(): void;
  /** 语义复核判为合规时的留痕（不产生告警） */
  dismiss?(ruleIds: string[]): void;
}

/**
 * 员工发言质检的两层判断：关键词负责不漏，模型负责不误报。
 *
 * - 没有可疑词：直接结束，不进模型；
 * - 命中但模型判合规：留痕不留告警；
 * - 模型判违规、或复核不可用（未安装 / 超时 / 报错）：照常告警。
 *   宁可多看一眼，也不能因为模型抖动漏掉真正的违规。
 */
export async function decideStaffQuality(
  input: { text: string },
  deps: StaffQualityDecisionDeps,
): Promise<StaffQualityOutcome> {
  let pre: { hits: string[]; hitNames: string[] } | undefined;
  try {
    pre = deps.precheck?.();
  } catch {
    // 初筛异常：退回纯关键词告警链路
    pre = undefined;
  }
  if (!pre) {
    deps.raiseAlert();
    return 'alerted';
  }
  if (pre.hits.length === 0) return 'clean';
  if (!deps.judge) {
    deps.raiseAlert();
    return 'alerted';
  }

  let verdict: 'violation' | 'ok' | 'unknown';
  try {
    verdict = await deps.judge({ text: input.text, ruleNames: pre.hitNames });
  } catch {
    verdict = 'unknown';
  }
  if (verdict !== 'ok') {
    deps.raiseAlert();
    return 'alerted';
  }
  try {
    deps.dismiss?.(pre.hits);
  } catch {
    // 留痕失败不改变判断：这句话已经复核为合规，不回头补告警
  }
  return 'dismissed';
}

/** 只依赖 zhiban-console 的话术只读入口；未安装控制台时查询会提示未接入 */
interface ScriptsApi {
  listEnabled(): QueryableScript[];
}

/** #162 zhiban-knowledge 暴露的只读检索入口 */
interface KnowledgeApi {
  list(query?: { q?: string; enabled?: boolean }): Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    enabled: boolean;
    deletedAt?: number;
  }>;
}

export function apply(ctx: DshPluginContext, rawConfig: unknown): void {
  const config = parsePluginConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-wecom] ${line}`);

  log(`加载配置：环境=${config.environment} 群数=${config.serviceGroupRoomIds.length}`);

  // #33/#34：患者域通过这个服务入队草稿、改稿与回执；先 provide 再启动，
  // 避免两个插件加载顺序不同导致对方拿不到服务。
  let serviceRef: C2Service | undefined;
  let botRef: WeComBotAdapter | undefined;
  /** #160：承诺账本；员工发言与草稿确认都会写入 */
  let promiseRef: PromiseService | undefined;
  /** #163：侧边栏关闭待回复时推进草稿状态（运行时创建后可用） */
  let acknowledgeRef:
    | ((draftId: string, action: 'sent' | 'skipped', actor: string) => Promise<void>)
    | undefined;
  /** #59：证据导出需要回读存档原文；运行时才创建，未就绪时证据降级为空 */
  let archiveRef: ArchivePort | undefined;
  /** #106：运行时服务群名单；控制台「开始服务 / 移出服务」改它 */
  let registryRef: ServiceGroupRegistry | undefined;
  const requireService = (): C2Service => {
    if (!serviceRef) throw new Error('WECOM_SERVICE_NOT_READY');
    return serviceRef;
  };
  const requireRegistry = (): ServiceGroupRegistry => {
    if (!registryRef) throw new Error('WECOM_SERVICE_NOT_READY');
    return registryRef;
  };

  /** 员工发言 → 顾问：P1 里顾问 id 与企微 userid 相同，同时兼容按 chatId 绑定 */
  const resolveStaffAdvisor = (userId: string) => {
    const found = (serviceRef?.store.listAdvisors() ?? []).find(
      (advisor) => advisor.id === userId || advisor.chatId === userId,
    );
    if (found) return found;
    if (userId === config.advisorId || userId === config.advisorChatId) {
      return {
        id: config.advisorId,
        name: config.advisorName,
        chatId: config.advisorChatId,
        status: 'active' as const,
        consecutiveMisroutes: 0,
      };
    }
    return undefined;
  };

  /** 命中后 1:1 提醒本人；提醒里只有群名与规则名，不含发言正文 */
  const notifyStaffQuality = async (input: {
    chatId: string;
    groupName: string;
    hitNames: string[];
  }): Promise<void> => {
    if (!botRef) return;
    try {
      await botRef.sendText(
        input.chatId,
        `【质检提醒】你在群「${input.groupName}」的发言命中了红线规则「${input.hitNames.join('、')}」。\n` +
          '这条已记录到「质检与告警」，并计入个人质检记录。请及时撤回或更正，必要时向主管说明。',
      );
    } catch (error) {
      log(`质检提醒推送失败：${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  };

  /** 员工发言质检：交给 zhiban-guard 关键词匹配，命中后由本插件推送 1:1 提醒 */
  const checkStaffMessage = (message: {
    msgid: string;
    from: string;
    roomId: string;
    groupName?: string;
    text: string;
  }): void => {
    // #160：顾问在群里手动说的话也可能包含承诺；与质检无关，先入账
    const speaker = resolveStaffAdvisor(message.from);
    if (speaker) {
      promiseRef?.ingestText({
        advisorId: speaker.id,
        roomId: message.roomId,
        groupName: message.groupName ?? '服务群',
        text: message.text,
        msgId: message.msgid,
        at: Date.now(),
      });
    }

    const guard = ctx.get<StaffQualityGuard>('zhibanGuard');
    if (!guard?.reviewStaffMessage) return;
    const advisor = resolveStaffAdvisor(message.from);
    const input = {
      text: message.text,
      ...(advisor ? { advisorId: advisor.id, advisorName: advisor.name } : {}),
      groupId: message.roomId,
      ...(message.groupName ? { groupName: message.groupName } : {}),
      messageId: message.msgid,
    };

    const raiseAlert = (): void => {
      const result = guard.reviewStaffMessage!(input);
      if (!result?.alertId) return;
      log(
        `员工发言命中红线：advisor=${tailId(advisor?.id ?? message.from)} ` +
          `group=${tailId(message.roomId)} rules=${result.hits.join(',')}（正文不落日志）`,
      );
      void notifyStaffQuality({
        chatId: advisor?.chatId ?? message.from,
        groupName: message.groupName ?? '服务群',
        hitNames: result.hitNames,
      });
    };

    // 关键词初筛 → 语义复核：没有可疑词不进模型；判为合规就不告警。
    // 复核链路异常一律按保守策略告警，且异常不能逃逸到宿主。
    const judge = ctx.get<StaffJudgeApi>('zhibanPatient')?.judgeStaffMessage;
    void decideStaffQuality(
      { text: message.text },
      {
        precheck: () => guard.checkStaffMessage?.(input),
        ...(judge ? { judge: (payload: { text: string; ruleNames: string[] }) => judge(payload) } : {}),
        raiseAlert,
        dismiss: (ruleIds) => {
          guard.dismissStaffMessage?.({
            ruleIds,
            ...(advisor ? { advisorId: advisor.id } : {}),
            groupId: message.roomId,
            messageId: message.msgid,
          });
        },
      },
    )
      .then((outcome) => {
        if (outcome !== 'dismissed') return;
        log(
          `员工发言关键词命中、语义复核为合规：advisor=${tailId(advisor?.id ?? message.from)} ` +
            `group=${tailId(message.roomId)}（正文不落日志）`,
        );
      })
      .catch((error: unknown) => {
        // 兜底：告警本身失败也要留日志，且不带发言正文
        try {
          raiseAlert();
        } catch {
          log(
            `员工发言质检失败 msgid=${tailId(message.msgid)}：` +
              `${error instanceof Error ? error.message : 'UNKNOWN'}`,
          );
        }
      });
  };
  const wecomBridge: PatientBridge = {
    async enqueueDraft(input) {
      const draft = requireService().enqueueDraft({
        advisorId: input.advisorId,
        groupRoomId: input.groupRoomId,
        customerId: input.customerId,
        customerName: input.customerName,
        lastInboundAt: input.lastInboundAt,
        inboundMessageId: input.inboundMessageIds[0] ?? `merged_${Date.now()}`,
        inboundMessageIds: input.inboundMessageIds,
        mediaIds: input.mediaIds,
        mediaKinds: input.mediaKinds,
        inboundSummary: input.inboundSummary,
        body: input.body,
        riskLevel: input.riskLevel,
        ruleIds: input.ruleIds,
        ruleNames: input.ruleNames,
        source: input.source,
        fallback: input.fallback,
        citedMemoryIds: input.citedMemoryIds,
        citedKnowledgeIds: input.citedKnowledgeIds,
      });
      return { draftId: draft.id, version: draft.version ?? 1 };
    },
    async reviseDraft(draftId, input) {
      const draft = requireService().reviseDraft(draftId, input);
      return { draftId: draft.id, version: draft.version ?? 1 };
    },
    requestRevision(draftId, instruction) {
      requireService().requestRevision(draftId, instruction);
    },
    getActiveDraft(advisorId) {
      const id = serviceRef?.store.getActiveDraft(advisorId);
      return id ? serviceRef?.store.getDraft(id) : undefined;
    },
    getDraft(draftId) {
      return serviceRef?.store.getDraft(draftId);
    },
    listVerifiedBodies(senderId) {
      return (
        serviceRef?.store
          .listDrafts()
          .filter(
            (draft) =>
              draft.customerId === senderId &&
              (draft.status === 'VERIFIED' || draft.status === 'EDIT_SENT'),
          )
          .map((draft) => draft.body) ?? []
      );
    },
    async notifyAdvisor(text) {
      if (!botRef) throw new Error('WECOM_BOT_NOT_READY');
      await botRef.sendText(config.advisorChatId, text);
    },
  };
  ctx.provide('zhibanWecom', wecomBridge);

  /** 证据窗口：草稿创建前后各取一段存档，覆盖合并输入与核验回读延迟 */
  const EVIDENCE_WINDOW_MS = 30 * 60_000;

  async function loadArchiveMessages(
    roomId: string,
    since: number,
    until: number,
  ): Promise<ArchivedInbound[]> {
    const archive = archiveRef;
    if (!archive) return [];
    try {
      if (typeof archive.listGroupMessages === 'function') {
        return await archive.listGroupMessages({ roomIds: [roomId], since, until, includeMedia: true });
      }
      return await archive.listInboundMessages({
        roomIds: [roomId],
        excludeSender: config.advisorChatId,
        since,
        until,
        includeMedia: true,
      });
    } catch {
      // 存档不可用时不阻塞导出；PDF 会标注「未取到存档原文」
      return [];
    }
  }

  function buildEvidence(draft: Draft, messages: ArchivedInbound[]) {
    const advisor = serviceRef?.store.getAdvisor(draft.advisorId);
    const revisions: DraftRevision[] =
      draft.revisions && draft.revisions.length > 0
        ? draft.revisions
        : [
            {
              version: draft.version ?? 1,
              body: draft.body,
              createdBy: 'agent',
              createdAt: draft.createdAt,
            },
          ];
    const inboundIds = new Set(
      draft.inboundMessageIds && draft.inboundMessageIds.length > 0
        ? draft.inboundMessageIds
        : [draft.inboundMessageId],
    );
    const inbound = messages
      .filter((message) => inboundIds.has(message.msgid))
      .sort((a, b) => a.msgtime - b.msgtime)
      .map((message) => ({
        msgid: message.msgid,
        from: message.from,
        text: message.text,
        msgtime: message.msgtime,
        ...(message.msgtype ? { msgtype: message.msgtype } : {}),
        ...(message.mediaPath ? { mediaPath: message.mediaPath } : {}),
      }));
    const verification = draft.verification
      ? {
          outcome: draft.verification.outcome,
          ...(draft.verification.matchedMsgId
            ? { matchedMsgId: draft.verification.matchedMsgId }
            : {}),
          ...(draft.verification.matchedRoomId
            ? { matchedRoomId: draft.verification.matchedRoomId }
            : {}),
          ...(draft.verification.similarity !== undefined
            ? { similarity: draft.verification.similarity }
            : {}),
          checkedAt: draft.verification.checkedAt,
        }
      : undefined;
    const matched = verification?.matchedMsgId;
    const sentMessage = matched ? messages.find((message) => message.msgid === matched) : undefined;
    return {
      id: draft.id,
      advisorId: draft.advisorId,
      ...(advisor ? { advisorName: advisor.name } : {}),
      groupRoomId: draft.groupRoomId,
      groupName: draft.groupName,
      customerName: draft.customerName,
      inboundSummary: draft.inboundSummary,
      inboundMessageIds: [...inboundIds],
      mediaIds: draft.mediaIds ?? [],
      body: draft.body,
      version: draft.version ?? revisions[revisions.length - 1]?.version ?? 1,
      revisions,
      status: draft.status,
      riskLevel: draft.riskLevel,
      ...(draft.source ? { source: draft.source } : {}),
      ...(draft.fallback !== undefined ? { fallback: draft.fallback } : {}),
      ...(draft.sentVersion !== undefined ? { sentVersion: draft.sentVersion } : {}),
      ...(verification ? { verification } : {}),
      ...(draft.ackAction ? { ackAction: draft.ackAction } : {}),
      ...(draft.ackAt !== undefined ? { ackAt: draft.ackAt } : {}),
      createdAt: draft.createdAt,
      ...(draft.pushedAt !== undefined ? { pushedAt: draft.pushedAt } : {}),
      citedMemoryIds: draft.citedMemoryIds ?? [],
      citedKnowledgeIds: draft.citedKnowledgeIds ?? [],
      inbound,
      sent: sentMessage
        ? { msgid: sentMessage.msgid, text: sentMessage.text, msgtime: sentMessage.msgtime }
        : null,
    };
  }

  // #39：控制台的队列释放 / 顾问恢复入口。方法内部懒取 service，
  // 让控制台插件先加载也不会拿到半初始化的实例。
  const adminApi = {
    async releaseQueue(advisorId: string, actor = 'admin') {
      const result = await requireService().releaseQueue(advisorId, actor);
      ctx.emit('draft.released', {
        draftId: result.releasedDraftId,
        advisorId,
        nextDraftId: result.nextDraftId,
      });
      return result;
    },
    restoreAdvisor(advisorId: string, actor = 'admin') {
      const advisor = requireService().restoreAdvisor(advisorId, actor);
      ctx.emit('advisor.updated', {
        id: advisor.id,
        name: advisor.name,
        status: advisor.status,
        consecutiveMisroutes: advisor.consecutiveMisroutes,
      });
      return {
        id: advisor.id,
        name: advisor.name,
        status: advisor.status,
        consecutiveMisroutes: advisor.consecutiveMisroutes,
      };
    },
    getDraft(draftId: string) {
      const draft = serviceRef?.store.getDraft(draftId);
      if (!draft) return undefined;
      return {
        id: draft.id,
        summary: draft.inboundSummary,
        status: draft.status,
        riskLevel: draft.riskLevel,
      };
    },
    getAdvisor(advisorId: string) {
      const advisor = serviceRef?.store.getAdvisor(advisorId);
      if (!advisor) return undefined;
      return { id: advisor.id, name: advisor.name, status: advisor.status };
    },
    // 控制台：真实服务流 / 顾问队列读取入口（只读副本，避免调用方改到领域对象）
    listDrafts() {
      return (serviceRef?.store.listDrafts() ?? []).map((draft) => structuredClone(draft));
    },
    getDraftDetail(draftId: string) {
      const draft = serviceRef?.store.getDraft(draftId);
      return draft ? structuredClone(draft) : undefined;
    },
    /**
     * #149：侧边栏读取「已生成、还没发出」的草稿。
     * 只读，不触发生成；顾问已确认发送或已发出的草稿不再展示。
     */
    latestSidebarDraft(roomId: string, since: number) {
      const draft = (serviceRef?.store.listDrafts() ?? [])
        .filter((item) => item.groupRoomId === roomId)
        .filter((item) => item.createdAt >= since)
        .filter((item) => item.status === 'PUSHED')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!draft) return undefined;
      return {
        id: draft.id,
        body: draft.body,
        riskLevel: draft.riskLevel,
        ruleNames: [...(draft.ruleNames ?? [])],
        createdAt: draft.createdAt,
        status: draft.status,
        ...(draft.verification
          ? {
              verification: {
                outcome: draft.verification.outcome,
                checkedAt: draft.verification.checkedAt,
              },
            }
          : {}),
      };
    },
    /**
     * #163：侧边栏「已处理 / 忽略」→ 确认草稿，随后由运行时回读核验。
     * 核验结果只回侧边栏，不再私聊推回执。
     */
    async acknowledgeDraft(
      draftId: string,
      action: 'sent' | 'skipped',
      actor = 'sidebar',
    ) {
      if (!acknowledgeRef) throw new Error('WECOM_RUNTIME_NOT_READY');
      await acknowledgeRef(draftId, action, actor);
    },
    listGroups() {
      return (serviceRef?.store.listGroups() ?? []).map((group) => structuredClone(group));
    },
    listAudits() {
      return (serviceRef?.store.listAudit() ?? []).map((event) => structuredClone(event));
    },
    /**
     * #106：控制台「开始服务」。
     * 把 roomid 加入存档白名单，并在 C2 域绑定为 mapped；无需重启。
     * 草稿仍然只推给 profile 配置的顾问（P1 单顾问），控制台选择的群顾问
     * 只影响患者域的服务归属。
     */
    activateServiceGroup(input: {
      roomId: string;
      name?: string;
      actor?: string;
    }) {
      const service = requireService();
      const registry = requireRegistry();
      const roomId = input.roomId.trim();
      if (roomId === '') throw new Error('INVALID_ROOM_ID');

      registry.activate(roomId);
      const existing = service.store.getGroup(roomId);
      const name = input.name?.trim() || existing?.name || `群 ${tailId(roomId)}`;
      // 绑定时把 chatId 补上：侧边栏拿 JS-SDK 的 chatId 查档案，两者同值
      service.bindGroup({ roomId, name, advisorId: config.advisorId, chatId: roomId });
      service.store.appendAudit({
        at: Date.now(),
        actor: input.actor ?? 'admin',
        action: 'service_group.activate',
        target: roomId,
        result: 'ok',
      });
      return { roomId, name, allowed: true };
    },
    /** #106：控制台「移出服务 / 忽略」。停止拉取并把 C2 群置为 disabled。 */
    deactivateServiceGroup(roomId: string, actor = 'admin') {
      const registry = requireRegistry();
      const trimmed = roomId.trim();
      if (trimmed === '') throw new Error('INVALID_ROOM_ID');

      registry.deactivate(trimmed);
      const group = serviceRef?.store.getGroup(trimmed);
      if (group && group.status !== 'disabled') {
        serviceRef!.store.saveGroup({ ...group, status: 'disabled' });
      }
      serviceRef?.store.appendAudit({
        at: Date.now(),
        actor,
        action: 'service_group.deactivate',
        target: trimmed,
        result: 'ok',
      });
      return { roomId: trimmed, allowed: false };
    },
    /** 控制台/排障：当前运行时允许的 roomid（不含昵称） */
    listServiceGroupRooms() {
      return registryRef?.roomIds() ?? [];
    },
    /** 手动暂停：只改顾问状态，不再推送草稿；恢复走 restoreAdvisor。 */
    pauseAdvisor(advisorId: string) {
      const advisor = serviceRef?.store.getAdvisor(advisorId);
      if (!advisor) return undefined;
      const updated = { ...advisor, status: 'paused' as const };
      serviceRef!.store.saveAdvisor(updated);
      ctx.emit('advisor.updated', {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        consecutiveMisroutes: updated.consecutiveMisroutes,
      });
      return {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        consecutiveMisroutes: updated.consecutiveMisroutes,
      };
    },
    // #59：证据链 / 服务记录导出。只读；存档不可用时降级为空原文。
    async getDraftEvidence(draftId: string) {
      const draft = serviceRef?.store.getDraft(draftId);
      if (!draft) return undefined;
      const messages = await loadArchiveMessages(
        draft.groupRoomId,
        draft.createdAt - EVIDENCE_WINDOW_MS,
        (draft.verification?.checkedAt ?? draft.pushedAt ?? draft.createdAt) + EVIDENCE_WINDOW_MS,
      );
      return buildEvidence(draft, messages);
    },
    async listDraftsByRooms(roomIds: string[], from: number, to: number) {
      const drafts = (serviceRef?.store.listDrafts() ?? []).filter(
        (draft) =>
          roomIds.includes(draft.groupRoomId) &&
          draft.createdAt >= from &&
          draft.createdAt < to,
      );
      const cache = new Map<string, ArchivedInbound[]>();
      const result = [];
      for (const draft of drafts) {
        let messages = cache.get(draft.groupRoomId);
        if (!messages) {
          messages = await loadArchiveMessages(
            draft.groupRoomId,
            from - EVIDENCE_WINDOW_MS,
            to + EVIDENCE_WINDOW_MS,
          );
          cache.set(draft.groupRoomId, messages);
        }
        result.push(buildEvidence(draft, messages));
      }
      return result;
    },
  };
  ctx.provide('zhibanWecomAdmin', adminApi);

  // 患者域同样懒加载：wecom 可以先启动，患者插件就绪后自动接管
  const patientApi = (): {
    observeRooms: PatientSink['observeRooms'];
    routeInbound(message: PatientInboundMessage): { handled: boolean; decision: RouteDecision };
    handleDraftVerified(draftId: string, outcome: VerifyOutcome): Promise<void>;
    handleAdvisorText(advisorUserId: string, text: string): Promise<boolean>;
    /** #159：服务状态是存档白名单的源头；旧版本患者域可能没有该方法 */
    listGroups?(): Array<{ roomId: string; status?: string }>;
  } | undefined => ctx.get('zhibanPatient');
  const patientSink: PatientSink = {
    observeRooms: (rooms) => patientApi()?.observeRooms(rooms),
    routeInbound: (message) =>
      patientApi()?.routeInbound(message) ?? {
        handled: false,
        decision: { action: 'ignore', reason: 'PATIENT_UNAVAILABLE' },
      },
    handleDraftVerified: async (draftId, outcome) => {
      await patientApi()?.handleDraftVerified(draftId, outcome);
    },
    handleAdvisorText: async (advisorUserId, text) =>
      (await patientApi()?.handleAdvisorText(advisorUserId, text)) ?? false,
  };

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(wecomDomain);
    let bot: WeComBotAdapter | undefined;

    try {
      let persistAlerted = false;
      const store = new DomainStore(new DomainStoreBackend(domain), (error) => {
        log(`领域存储写入失败：${error.message}`);
        if (persistAlerted) return;
        persistAlerted = true;
        const alert: Alert = {
          kind: 'PERSIST_FAILED',
          message: `领域存储写入失败：${error.message}`,
          at: Date.now(),
        };
        ctx.emit('alert.created', alert);
      });

      const clock = { now: () => Date.now() };
      // 语音转写：凭据缺失时 available=false，语音消息保持「不处理」
      const asr = tencentAsrFromEnv();
      if (!asr.available) log('语音识别未配置：客户语音消息不会被转写');

      // 运行时服务群名单：profile 白名单只是种子，控制台可在运行时增删
      const registry = new ServiceGroupRegistry({
        seedRoomIds: config.serviceGroupRoomIds,
        snapshot: store.getMeta('service_roster'),
        now: () => clock.now(),
        save: (snapshot) => store.setMeta('service_roster', snapshot),
      });
      registryRef = registry;

      // 群昵称：凭据齐全才启用；不可用时患者域继续显示 id 尾号
      const groupInfo = new GroupInfoClient({
        corpId: config.corpId,
        contactSecret: config.contactSecret,
        clock,
        logger: log,
      });
      if (!groupInfo.enabled) {
        log('群昵称查询未启用：缺少 contactSecret / corpId，成员显示 id 尾号');
      }

      // 会话存档同意状态：复用存档 config.txt 的 corpid/secret（msgaudit 应用）
      const roomAgree = new RoomAgreeClient({
        configPath: config.archive.configPath,
        clock,
        logger: log,
      });
      if (!roomAgree.enabled) {
        log('存档同意同步未启用：无法读取存档凭据，成员保持「存档待确认」');
      }

      const archive = new WeComArchiveAdapter({
        binaryPath: config.archive.binaryPath,
        privateKeyPath: config.archive.privateKeyPath,
        configPath: config.archive.configPath,
        batchSize: config.archive.batchSize,
        maxBatchesPerPoll: config.archive.maxBatchesPerPoll,
        cacheLimit: config.archive.cacheLimit,
        // 每轮轮询都会调用；名单在控制台「开始服务 / 移出服务」后即时生效
        isServiceGroup: (roomId) => registry.isAllowed(roomId),
        // #159：顾问与外部客户之间的单聊保留正文（供待回复索引展示）；
        // 与 AI 助手、内部应用的会话以及对端不是客户的单聊仍只留元数据
        isServedDm: (record) => {
          if (record.roomid) return false;
          const staff = config.advisorChatId;
          const from = typeof record.from === 'string' ? record.from : '';
          const to = (record.tolist ?? []).filter(
            (id): id is string => typeof id === 'string' && id !== '',
          );
          if (from === staff) return isExternalCustomerId(to[0] ?? '');
          return to.includes(staff) && isExternalCustomerId(from);
        },
        media: {
          rootDir: config.mediaRootDir,
          binaryPath: config.archive.binaryPath,
          configPath: config.archive.configPath,
        },
        transcribeVoice: asr.available
          ? async (audio: Buffer) => {
              const started = Date.now();
              const text = await asr.transcribe(audio);
              log(`语音识别完成 耗时=${Date.now() - started}ms chars=${text.length}`);
              return text;
            }
          : undefined,
        logger: log,
      });
      archive.setSeq(store.getMeta<number>('archive_seq') ?? 0);
      archiveRef = archive;

      let runtime: WecomRuntime | undefined;
      let confirmHandler: ((key: string) => void) | undefined;

      // 顾问在企微 1:1 查话术；只回复本人，不向客户群发送（F1）
      const scriptQuery = new ScriptQueryService(
        () => ctx.get<ScriptsApi>('zhibanScripts'),
        () => clock.now(),
      );

      // 「我的待办 / 我的草稿」：只读本人名下的草稿、承诺与告警，不调模型
      const advisorStatus = new AdvisorStatusService({
        drafts: (advisorId) =>
          store
            .listDrafts()
            .filter((draft) => draft.advisorId === advisorId)
            .map((draft) => ({
              groupName: draft.groupName,
              riskLevel: draft.riskLevel,
              status: draft.status,
              since: draft.pushedAt ?? draft.queuedAt ?? draft.createdAt,
              ...(draft.version !== undefined ? { version: draft.version } : {}),
            })),
        promises: (advisorId) =>
          store
            .listPromises()
            .filter((promise) => promise.advisorId === advisorId && promise.status === 'pending')
            .map((promise) => ({
              groupName: promise.groupName,
              dueAt: promise.dueAt,
              dueLabel: promise.dueLabel,
            })),
        alerts: (advisorId) =>
          (ctx.get<StaffQualityGuard>('zhibanGuard')?.alerts?.() ?? [])
            .filter(
              (alert) =>
                alert.advisorId === advisorId && (alert.status === undefined || alert.status === 'open'),
            )
            .map((alert) => ({
              title: alert.kind === 'redline' ? '员工发言命中红线' : '已升级人工',
              at: alert.createdAt,
            })),
        now: () => clock.now(),
      });

      // #162：知识检索与判定解释；只读知识库与本人草稿
      const knowledgeQuery = new KnowledgeQueryService({
        source: () => ctx.get<KnowledgeApi>('zhibanKnowledge'),
        latestDraft: (userId) => {
          const advisor = resolveStaffAdvisor(userId);
          if (!advisor) return undefined;
          const activeId = serviceRef?.store.getActiveDraft(advisor.id);
          const draft =
            (activeId ? serviceRef?.store.getDraft(activeId) : undefined) ??
            serviceRef?.store
              .listDrafts()
              .filter((item) => item.advisorId === advisor.id)
              .sort((a, b) => b.createdAt - a.createdAt)[0];
          if (!draft) return undefined;
          return {
            id: draft.id,
            riskLevel: draft.riskLevel,
            ruleNames: [...(draft.ruleNames ?? [])],
            hasRuleEvidence: (draft.ruleIds?.length ?? 0) > 0,
          };
        },
        // 员工发言质检：只取本人最近一次命中，规则名与关键词来自 guard，正文不回显
        staffRedline: (userId) => {
          const advisor = resolveStaffAdvisor(userId);
          if (!advisor) return undefined;
          const guard = ctx.get<StaffQualityGuard>('zhibanGuard');
          const latest = (guard?.alerts?.() ?? [])
            .filter(
              (alert) =>
                alert.kind === 'redline' &&
                alert.source === 'staff' &&
                alert.advisorId === advisor.id,
            )
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          if (!latest) return undefined;
          const rules = latest.ruleIds
            .map((id) => guard?.getRule?.(id))
            .filter((rule): rule is { name: string; keywords: string[] } => rule !== undefined);
          if (rules.length === 0) return { ruleNames: [], keywords: [] };
          return {
            ruleNames: rules.map((rule) => rule.name),
            keywords: [...new Set(rules.flatMap((rule) => rule.keywords))],
          };
        },
        now: () => clock.now(),
      });

      bot = new WeComBotAdapter(
        { botId: config.botId, secret: config.botSecret, logger: log },
        {
          onMessage: (message) => {
            log(
              `机器人收到消息 chattype=${message.chattype} msgtype=${message.msgtype} ` +
                `user=${tailId(message.userid)}（正文不落日志）`,
            );
            if (message.chattype === 'single' && message.msgtype === 'text' && message.text) {
              // 「话术 …」「知识 …」「我的待办」是查询指令；看过列表后直接发编号也取全文；
              // 其余文本按改稿指令处理（#56）
              const statusAdvisor = resolveStaffAdvisor(message.userid);
              const reply =
                knowledgeQuery.reply(message.userid, message.text) ??
                scriptQuery.reply(message.userid, message.text) ??
                scriptQuery.replyToSelection(message.userid, message.text) ??
                knowledgeQuery.replyToSelection(message.userid, message.text) ??
                (statusAdvisor ? advisorStatus.reply(statusAdvisor.id, message.text) : undefined);
              if (reply !== undefined) {
                const target = botRef;
                if (target) {
                  void (async () => {
                    // 长文本按字节拆成多条，避免超过企微 markdown 单条上限
                    for (const chunk of splitForWecom(reply)) {
                      await target.sendText(message.userid, chunk);
                    }
                  })().catch((error: unknown) =>
                    log(
                      `指令回复失败 user=${tailId(message.userid)}：` +
                        `${error instanceof Error ? error.message : 'UNKNOWN'}`,
                    ),
                  );
                }
                return;
              }
              void runtime?.handleAdvisorMessage(message.userid, message.text);
            }
          },
          onEvent: (event) => {
            if (event.eventKey) confirmHandler?.(event.eventKey);
          },
          onClose: (code) => runtime?.handleBotClose(code),
        },
      );

      const service = new C2Service({
        store,
        bot,
        archive,
        clock,
        config: {
          initialSeq: maxDraftSeq(store.listDrafts()),
          // #39：60 分钟升级时 1:1 推送给配置的主管
          queue: { supervisorChatIds: config.supervisorChatIds },
        },
        onAlert: (alert) => {
          ctx.emit('alert.created', alert);
          log(`告警 ${alert.kind}${alert.draftId ? ` draft=${alert.draftId}` : ''}`);
        },
      });
      serviceRef = service;
      botRef = bot;

      // #160：承诺追踪。只读顾问自己的发言，提醒只发本人 1:1。
      const promiseService = new PromiseService({
        store,
        bot,
        clock,
        chatIdFor: (advisorId) => store.getAdvisor(advisorId)?.chatId,
        logger: log,
      });
      promiseRef = promiseService;

      // #161：每日巡检。信号落告警（控制台可见），汇总只发顾问本人。
      const patrolService = new PatrolService({
        archive,
        bot,
        clock,
        groups: () => store.listGroups(),
        advisorUserId: config.advisorChatId,
        advisorChatId: config.advisorChatId,
        advisorId: config.advisorId,
        emitAlert: (alert) => {
          store.emitAlert(alert);
          ctx.emit('alert.created', alert);
          log(`巡检告警 ${alert.kind}`);
        },
        state: {
          get: (key) => store.getMeta(key),
          set: (key, value) => store.setMeta(key, value),
        },
        patientNameForRoom: (roomId) => {
          const patient = ctx.get<{
            listGroups(): Array<{ roomId: string; patientIds: string[] }>;
            getPatientAdmin(id: string): { displayName: string } | undefined;
          }>('zhibanPatient');
          const patientId = patient?.listGroups().find((group) => group.roomId === roomId)
            ?.patientIds[0];
          return patientId ? patient?.getPatientAdmin(patientId)?.displayName : undefined;
        },
        canReadPatient: true,
        logger: log,
      });

      // 顾问与群绑定：已存在则保留，同步配置里的显示名与 chatId
      const advisor = store.getAdvisor(config.advisorId);
      if (!advisor) {
        service.addAdvisor({
          id: config.advisorId,
          name: config.advisorName,
          chatId: config.advisorChatId,
        });
      } else if (advisor.chatId !== config.advisorChatId || advisor.name !== config.advisorName) {
        store.saveAdvisor({
          ...advisor,
          name: config.advisorName,
          chatId: config.advisorChatId,
        });
      }
      for (const roomId of registry.roomIds()) {
        if (store.getGroup(roomId)) continue;
        service.bindGroup({
          roomId,
          name: config.groupName,
          advisorId: config.advisorId,
          // 客户群 chatId 与 roomId 同值；groupChatId 只在旧单群配置里出现
          chatId: config.groupChatId ?? roomId,
        });
      }

      const lastRunAt = store.getMeta<number>('last_run_at');
      const now = clock.now();
      const downtimeGapMs =
        typeof lastRunAt === 'number' && now - lastRunAt > config.downtimeThresholdMs
          ? now - lastRunAt
          : undefined;
      // 正常重启从上次运行时刻续拉；停机过久则从当前时刻开始，不补历史
      const startedAt = downtimeGapMs === undefined ? (lastRunAt ?? now) : now;
      if (typeof lastRunAt === 'number') {
        log(`上次运行于 ${new Date(lastRunAt).toISOString()}，存档 seq=${archive.getSeq()}`);
      }

      const trigger = new ArchiveTrigger({
        archive,
        store,
        clock,
        compose: makeTemplateCompose(config),
        config: {
          // 每轮重新取：控制台新增的服务群无需重启
          roomIds: () => registry.roomIds(),
          excludeSender: config.advisorId,
          startedAt,
          includeMedia: true,
        },
        logger: log,
      });

      // 只发现企业创建的客户群：客户群列表接口返回的群，登记为候选待人工确认
      const discovery =
        config.serviceGroupDiscovery.enabled && groupInfo.enabled
          ? new GroupDiscovery({
              client: groupInfo,
              registry,
              patient: () => patientApi(),
              now: () => clock.now(),
              maxPerScan: config.serviceGroupDiscovery.maxPerScan,
              ownerUserIds: config.serviceGroupDiscovery.ownerUserIds,
              logger: log,
            })
          : undefined;
      if (config.serviceGroupDiscovery.enabled && !groupInfo.enabled) {
        log('服务群自动发现未启用：缺少 contactSecret / corpId');
      }

      // #159：患者域的服务状态是白名单源头。控制台切换状态会实时同步白名单，
      // 但沙盒预置或企微域离线期间的状态变更不走那条路径——每轮轮询前对齐兜底
      const reconcileFromPatient = () => {
        const groups = patientApi()?.listGroups?.() ?? [];
        const active = groups.filter(
          (group) => group.status === 'serving' || group.status === 'collect_only',
        ).length;
        log(`服务群白名单对齐：患者域 ${groups.length} 群（活跃 ${active}）`);
        reconcileServiceGroups(registry, groups, log);
      };

      runtime = new WecomRuntime({
        store,
        service,
        archive,
        trigger,
        bot,
        config,
        clock,
        patient: patientSink,
        staffQuality: checkStaffMessage,
        promises: promiseService,
        patrol: patrolService,
        // #146：加载顺序不确定，getter 每条消息现取
        sidebar: () => ctx.get<SidebarSink>('zhibanSidebar'),
        reconcileServiceGroups: reconcileFromPatient,
        groupInfo,
        roomAgree,
        discovery: discovery
          ? { scanOnce: () => discovery.scanOnce(), intervalMs: config.serviceGroupDiscovery.intervalMs }
          : undefined,
        emit: (type, data) => {
          ctx.emit(type, data);
        },
        logger: log,
      });
      confirmHandler = (key) => {
        void runtime?.handleButtonKey(key);
      };
      acknowledgeRef = (draftId, action, actor) =>
        runtime!.acknowledgeFromSidebar(draftId, action, actor);

      await bot.connect();
      runtime.start({ downtimeGapMs });
      log(`已就绪：顾问=${config.advisorId}，群=${registry.roomIds().join(',')}`);
      log('提示：同一机器人只允许一个长连接；开发环境请使用「知伴-开发」机器人（F14）');

      return async () => {
        await runtime?.stop();
        bot?.close();
        serviceRef = undefined;
        botRef = undefined;
        promiseRef = undefined;
        acknowledgeRef = undefined;
        registryRef = undefined;
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      bot?.close();
      serviceRef = undefined;
      botRef = undefined;
      registryRef = undefined;
      await domain.close();
      throw error;
    }
  });
}
