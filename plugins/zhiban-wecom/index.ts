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

import { WeComArchiveAdapter } from '../../src/c2/adapters/wecom-archive.ts';
import { WeComBotAdapter } from '../../src/c2/adapters/wecom-bot.ts';
import { tailId } from '../../src/c2/redact.ts';
import { C2Service } from '../../src/c2/service.ts';
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
import type { InboundMessage as PatientInboundMessage, RouteDecision } from '../../src/p1/types.ts';

import { parsePluginConfig } from './config.ts';
import { DomainStore, DomainStoreBackend, wecomDomain } from './domain.ts';
import { GroupDiscovery } from './group-discovery.ts';
import { GroupInfoClient } from './group-info.ts';
import { RoomAgreeClient } from './room-agree.ts';
import { makeTemplateCompose, WecomRuntime } from './runtime.ts';
import type { PatientSink } from './runtime.ts';
import { ServiceGroupRegistry } from './service-groups.ts';

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

export function apply(ctx: DshPluginContext, rawConfig: unknown): void {
  const config = parsePluginConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-wecom] ${line}`);

  log(`加载配置：环境=${config.environment} 群数=${config.serviceGroupRoomIds.length}`);

  // #33/#34：患者域通过这个服务入队草稿、改稿与回执；先 provide 再启动，
  // 避免两个插件加载顺序不同导致对方拿不到服务。
  let serviceRef: C2Service | undefined;
  let botRef: WeComBotAdapter | undefined;
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
      service.bindGroup({ roomId, name, advisorId: config.advisorId });
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
        media: {
          rootDir: config.mediaRootDir,
          binaryPath: config.archive.binaryPath,
          configPath: config.archive.configPath,
        },
        logger: log,
      });
      archive.setSeq(store.getMeta<number>('archive_seq') ?? 0);
      archiveRef = archive;

      let runtime: WecomRuntime | undefined;
      let confirmHandler: ((key: string) => void) | undefined;

      bot = new WeComBotAdapter(
        { botId: config.botId, secret: config.botSecret, logger: log },
        {
          onMessage: (message) => {
            log(
              `机器人收到消息 chattype=${message.chattype} msgtype=${message.msgtype} ` +
                `user=${tailId(message.userid)}（正文不落日志）`,
            );
            // #56：顾问与机器人的 1:1 文本 = 改稿指令
            if (message.chattype === 'single' && message.msgtype === 'text' && message.text) {
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

      // 顾问与群绑定：已存在则保留，只同步配置里的 chatId
      const advisor = store.getAdvisor(config.advisorId);
      if (!advisor) {
        service.addAdvisor({
          id: config.advisorId,
          name: config.advisorName,
          chatId: config.advisorChatId,
        });
      } else if (advisor.chatId !== config.advisorChatId) {
        store.saveAdvisor({ ...advisor, chatId: config.advisorChatId });
      }
      for (const roomId of registry.roomIds()) {
        if (store.getGroup(roomId)) continue;
        service.bindGroup({
          roomId,
          name: config.groupName,
          advisorId: config.advisorId,
          chatId: config.groupChatId,
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

      runtime = new WecomRuntime({
        store,
        service,
        archive,
        trigger,
        bot,
        config,
        clock,
        patient: patientSink,
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

      await bot.connect();
      runtime.start({ downtimeGapMs });
      log(`已就绪：顾问=${config.advisorId}，群=${registry.roomIds().join(',')}`);
      log('提示：同一机器人只允许一个长连接；开发环境请使用「知伴-开发」机器人（F14）');

      return async () => {
        await runtime?.stop();
        bot?.close();
        serviceRef = undefined;
        botRef = undefined;
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
