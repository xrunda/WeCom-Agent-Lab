/**
 * zhiban-wecom 插件运行时（#32 / #65）。
 *
 * 负责把 C2 的四个同步/异步组件接起来：
 *   存档轮询 → ArchiveTrigger → C2Service.enqueueDraft → SerialQueue → BotPort
 * 以及把领域事件发到 DSH 事件总线、把 seq / 最后运行时刻持久化。
 *
 * 日志只打元数据，不打消息正文。
 */
import type { ArchiveTrigger } from '../../src/c2/trigger.ts';
import type { ComposeFn } from '../../src/c2/trigger.ts';
import type { C2Service } from '../../src/c2/service.ts';
import { tailId } from '../../src/c2/redact.ts';
import type { BotPort, Clock } from '../../src/c2/ports.ts';
import type { Alert, Draft, VerifyOutcome } from '../../src/c2/types.ts';
import type { WeComArchiveAdapter } from '../../src/c2/adapters/wecom-archive.ts';
import type { WecomPluginConfig } from './config.ts';
import type { DomainStore } from './domain.ts';

export interface WecomRuntimeDeps {
  store: DomainStore;
  service: C2Service;
  archive: WeComArchiveAdapter;
  trigger: ArchiveTrigger;
  /** 顾问 1:1 会话；用于发送「已记录 / 校验结果」回执 */
  bot: BotPort;
  config: WecomPluginConfig;
  clock: Clock;
  /** 发到 DSH 事件总线：ctx.emit(type, data) */
  emit: (type: string, data: unknown) => void;
  logger?: (line: string) => void;
}

export interface StartOptions {
  /** 检测到的停机时长；undefined 表示没有超过阈值 */
  downtimeGapMs?: number;
}

/** 默认模板草稿；P1-R-04 会替换为 Agent 生成 */
export function makeTemplateCompose(
  config: WecomPluginConfig,
): ComposeFn {
  return ({ group, message }) => {
    const customerName = tailId(message.from);
    const body = config.composeTemplate
      ? config.composeTemplate
          .replaceAll('{customerName}', customerName)
          .replaceAll('{groupName}', group.name)
          .replaceAll('{advisorName}', config.advisorName)
      : `您好，已收到您的消息。${config.advisorName}稍后为您详细解答，如有紧急情况请直接来电。`;
    return {
      body,
      inboundSummary: summarizeText(message.text),
      customerName,
      riskLevel: 'low',
    };
  };
}

function summarizeText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 40)}…`;
}

function verificationNotice(draft: Draft, outcome: VerifyOutcome): string {
  const quote = `客户原文「${draft.inboundSummary}」`;
  switch (outcome) {
    case 'VERIFIED':
      return `✅ 校验通过：${quote} 的回复已在「${draft.groupName}」里找到，这条任务完成。`;
    case 'EDIT_SENT':
      return `✅ 已发送（内容有改动）：在「${draft.groupName}」里找到了相近的正文，这条任务完成。`;
    case 'MISROUTE_ALERT':
      return `⚠️ 错群：${quote} 的回复出现在别的群，不在「${draft.groupName}」。请检查后手动处理。`;
    case 'UNVERIFIED':
      return `❌ 没有在「${draft.groupName}」里找到这条正文，请确认是否真的粘贴发出去了。`;
    default:
      return `校验结果：${outcome}（${quote}）`;
  }
}

export class WecomRuntime {
  private readonly store: DomainStore;
  private readonly service: C2Service;
  private readonly archive: WeComArchiveAdapter;
  private readonly trigger: ArchiveTrigger;
  private readonly bot: BotPort;
  private readonly config: WecomPluginConfig;
  private readonly clock: Clock;
  private readonly emit: (type: string, data: unknown) => void;
  private readonly logger?: (line: string) => void;

  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private polling = false;
  private ticking = false;
  private lastRunPersistAt = 0;

  constructor(deps: WecomRuntimeDeps) {
    this.store = deps.store;
    this.service = deps.service;
    this.archive = deps.archive;
    this.trigger = deps.trigger;
    this.bot = deps.bot;
    this.config = deps.config;
    this.clock = deps.clock;
    this.emit = deps.emit;
    this.logger = deps.logger;
  }

  /** 启动轮询与队列；effect 清理时调用 stop() */
  start(options: StartOptions = {}): void {
    if (this.running) return;
    this.running = true;
    const now = this.clock.now();

    if (options.downtimeGapMs !== undefined) {
      const minutes = Math.max(1, Math.round(options.downtimeGapMs / 60_000));
      const alert: Alert = {
        kind: 'DOWNTIME',
        message: `检测到停机 ${minutes} 分钟，停机期间的消息不生成草稿`,
        at: now,
      };
      this.store.emitAlert(alert);
      this.emit('alert.created', alert);
      this.store.appendAudit({
        at: now,
        actor: 'pipeline',
        action: 'downtime',
        target: 'archive',
        result: 'skipped',
        errorCode: `DOWNTIME_${minutes}m`,
      });
      this.log(`检测到停机 ${minutes} 分钟，已跳过错过的消息`);
    }

    this.persistProgress();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.config.pollIntervalMs);
    this.tickTimer = setInterval(() => {
      void this.tickOnce();
    }, this.config.tickIntervalMs);
    this.pollTimer.unref?.();
    this.tickTimer.unref?.();
    this.log(
      `已启动：环境=${this.config.environment}，轮询 ${this.config.pollIntervalMs}ms，` +
        `队列 ${this.config.tickIntervalMs}ms`,
    );
  }

  /** 停止定时器并等待剩余写入落盘 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = undefined;
    this.tickTimer = undefined;
    this.persistProgress(true);
    await this.store.flush();
  }

  /** 拉一轮存档、生成草稿、跑一次队列；测试可直接调用 */
  async pollOnce(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      const events = await this.trigger.poll();
      for (const event of events) {
        let draft: Draft;
        try {
          draft = this.service.enqueueDraft({
            advisorId: this.config.advisorId,
            groupRoomId: event.group.roomId,
            groupNameSource: 'config',
            customerId: event.message.from,
            customerName: event.draft.customerName ?? tailId(event.message.from),
            lastInboundAt: event.message.msgtime,
            inboundMessageId: event.message.msgid,
            inboundSummary: event.draft.inboundSummary ?? summarizeText(event.message.text),
            body: event.draft.body,
            riskLevel: event.draft.riskLevel,
          });
        } catch (error) {
          this.log(
            `草稿入队失败 msgid=${tailId(event.message.msgid)}：` +
              `${error instanceof Error ? error.message : 'UNKNOWN'}`,
          );
          continue;
        }
        this.emit('draft.created', {
          draftId: draft.id,
          patientId: event.message.from,
          groupId: event.group.roomId,
          advisorId: draft.advisorId,
          source: 'template',
          riskLevel: draft.riskLevel,
          status: draft.status,
        });
      }
      this.persistProgress();
      await this.tickOnce();
    } catch (error) {
      this.log(
        `存档轮询失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.polling = false;
    }
  }

  /** 跑一次串行队列与核验；测试可直接调用 */
  async tickOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { pushed, verified } = await this.service.tick();
      for (const result of pushed) {
        if (!result.pushed) continue;
        const draft = this.store.getDraft(result.draftId);
        this.emit('draft.pushed', {
          draftId: result.draftId,
          advisorId: result.advisorId,
          status: draft?.status ?? 'PUSHED',
          cardTaskId: draft?.cardMessageId,
        });
      }
      for (const result of verified) {
        this.emit('draft.verified', {
          draftId: result.draftId,
          outcome: result.outcome,
          matchedGroupName: undefined,
          similarity: result.similarity,
        });
        const draft = result.draftId ? this.store.getDraft(result.draftId) : undefined;
        if (draft) await this.notify(verificationNotice(draft, result.outcome));
      }
      this.persistProgress();
    } catch (error) {
      this.log(
        `队列 tick 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  /** 机器人卡片按钮回调 */
  async handleButtonKey(key: string): Promise<void> {
    try {
      const draft = this.service.handleButtonCallback(key);
      this.emit('draft.acked', {
        draftId: draft.id,
        advisorId: draft.advisorId,
        ackAction: draft.ackAction,
      });
      this.log(`顾问确认草稿 ${draft.id} → ${draft.status}`);
      if (draft.status === 'SKIPPED') {
        await this.notify(`已忽略这条草稿（客户原文「${draft.inboundSummary}」），不会再回读校验。`);
      } else {
        await this.notify(
          `已记录「已发送」（客户原文「${draft.inboundSummary}」）。正在回读会话存档确认，稍后告诉你结果。`,
        );
      }
      await this.tickOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('ALREADY_ACKNOWLEDGED')) {
        this.log(`重复点击，忽略（${message}）`);
        await this.notify('这条草稿已经处理过了，无需重复点击。');
        return;
      }
      this.log(`确认失败：${message}`);
    }
  }

  /** 长连接关闭：#65 要求 demo 被踢时立刻告警 */
  handleBotClose(code: number): void {
    this.log(`长连接已关闭 code=${code}`);
    if (this.config.environment !== 'demo') return;

    const alert: Alert = {
      kind: 'BOT_DISCONNECTED',
      message: `demo 机器人长连接被关闭（code=${code}）；可能被其他实例顶掉，请检查开发环境是否误用 demo 凭据`,
      at: this.clock.now(),
    };
    this.store.emitAlert(alert);
    this.emit('alert.created', alert);
  }

  /** 把校验结果翻成顾问看得懂的一句话；卡片按钮不会变，只能补文字回执 */
  private notify(text: string): Promise<void> {
    return this.bot
      .sendText(this.config.advisorChatId, text)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.log(
          `回执发送失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** 把存档 seq 与最后运行时刻写进领域存储，重启后从此处续拉 */
  private persistProgress(force = false): void {
    const seq = this.archive.getSeq();
    if (this.store.getMeta<number>('archive_seq') !== seq) {
      this.store.setMeta('archive_seq', seq);
    }
    const now = this.clock.now();
    // last_run_at 只用于停机判定，每 60s 落一次，避免每条轮询都写盘
    if (force || now - this.lastRunPersistAt >= 60_000) {
      this.store.setMeta('last_run_at', now);
      this.lastRunPersistAt = now;
    }
  }

  private log(line: string): void {
    this.logger?.(line);
  }
}
