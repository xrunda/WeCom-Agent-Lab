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
import type { Alert, Draft } from '../../src/c2/types.ts';

import { parsePluginConfig, serviceGroupFilter } from './config.ts';
import { DomainStore, DomainStoreBackend, wecomDomain } from './domain.ts';
import { makeTemplateCompose, WecomRuntime } from './runtime.ts';

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
                `user=${tailId(message.userid)}（只处理卡片回调，正文不落日志）`,
            );
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
        config: { initialSeq: maxDraftSeq(store.listDrafts()) },
        onAlert: (alert) => {
          ctx.emit('alert.created', alert);
          log(`告警 ${alert.kind}${alert.draftId ? ` draft=${alert.draftId}` : ''}`);
        },
      });

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
        await domain.close();
        log('已停止并落盘');
      };
    } catch (error) {
      bot?.close();
      await domain.close();
      throw error;
    }
  });
}
