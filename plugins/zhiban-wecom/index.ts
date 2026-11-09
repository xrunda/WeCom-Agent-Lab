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
import type { Alert, Draft, VerifyOutcome } from '../../src/c2/types.ts';
import type { PatientBridge } from '../../src/p1/session-port.ts';
import type { InboundMessage as PatientInboundMessage, RouteDecision } from '../../src/p1/types.ts';

import { parsePluginConfig, serviceGroupFilter } from './config.ts';
import { DomainStore, DomainStoreBackend, wecomDomain } from './domain.ts';
import { makeTemplateCompose, WecomRuntime } from './runtime.ts';
import type { PatientSink } from './runtime.ts';

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
  const requireService = (): C2Service => {
    if (!serviceRef) throw new Error('WECOM_SERVICE_NOT_READY');
    return serviceRef;
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
        inboundSummary: input.inboundSummary,
        body: input.body,
        riskLevel: input.riskLevel,
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
      const archive = new WeComArchiveAdapter({
        binaryPath: config.archive.binaryPath,
        privateKeyPath: config.archive.privateKeyPath,
        configPath: config.archive.configPath,
        batchSize: config.archive.batchSize,
        maxBatchesPerPoll: config.archive.maxBatchesPerPoll,
        cacheLimit: config.archive.cacheLimit,
        isServiceGroup: serviceGroupFilter(config),
        media: {
          rootDir: config.mediaRootDir,
          binaryPath: config.archive.binaryPath,
          configPath: config.archive.configPath,
        },
        logger: log,
      });
      archive.setSeq(store.getMeta<number>('archive_seq') ?? 0);

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
      for (const roomId of config.serviceGroupRoomIds) {
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
          roomIds: config.serviceGroupRoomIds,
          excludeSender: config.advisorId,
          startedAt,
          includeMedia: true,
        },
        logger: log,
      });

      runtime = new WecomRuntime({
        store,
        service,
        archive,
        trigger,
        bot,
        config,
        clock,
        patient: patientSink,
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
      log(`已就绪：顾问=${config.advisorId}，群=${config.serviceGroupRoomIds.join(',')}`);
      log('提示：同一机器人只允许一个长连接；开发环境请使用「知伴-开发」机器人（F14）');

      return async () => {
        await runtime?.stop();
        bot?.close();
        serviceRef = undefined;
        botRef = undefined;
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      bot?.close();
      serviceRef = undefined;
      botRef = undefined;
      await domain.close();
      throw error;
    }
  });
}
