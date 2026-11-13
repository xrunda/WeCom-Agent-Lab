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
import type { Alert, ArchivedInbound, Draft, VerifyOutcome } from '../../src/c2/types.ts';
import type { WeComArchiveAdapter } from '../../src/c2/adapters/wecom-archive.ts';
import { dmConvKey, groupConvKey } from '../../src/p1/sidebar.ts';
import type { SidebarSink } from '../../src/p1/sidebar.ts';
import type {
  ConsentStatus,
  InboundMessage as PatientInboundMessage,
  RouteDecision,
} from '../../src/p1/types.ts';
import type { WecomPluginConfig } from './config.ts';
import type { DomainStore } from './domain.ts';
import type { GroupInfoClient, RoomInfo } from './group-info.ts';
import type { RoomAgreeClient } from './room-agree.ts';

/**
 * #159 单聊摄取的回看窗口：每轮都拉最近 24h 的存档单聊，
 * 靠待回复索引的 msgid 幂等去重。回看窗口大于轮询间隔即可。
 */
const DM_INGEST_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * #33/#34/#63/#56：由 zhiban-patient 提供的可选能力。
 * wecom 只负责把存档消息转交过去，不依赖患者域实现。
 */
export interface PatientSink {
  observeRooms(
    rooms: Array<{
      roomId: string;
      members: Array<{
        id: string;
        isExternal: boolean;
        lastActiveAt: number;
        /** 客户联系 API 拿到的群昵称；拿不到时缺省，由患者域回退 id 尾号 */
        displayName?: string;
      }>;
      /**
       * 企微里当前的群名；拿不到时缺省。患者域按「非手工命名才覆盖」的规则同步。
       */
      groupName?: string;
      /**
       * 整群 userid → 昵称映射。本轮没发言、但已经在患者域里的成员
       * 也能据此更新名称与回填患者；拿不到昵称时缺省。
       */
      memberNames?: Record<string, string>;
      /**
       * externalUserid → 会话存档同意状态。来自企微 check_room_agree；
       * 查询失败或未配置凭据时缺省，患者域保持原状态。
       */
      memberConsent?: Record<string, ConsentStatus>;
    }>,
  ): void;
  routeInbound(message: PatientInboundMessage): { handled: boolean; decision: RouteDecision };
  handleDraftVerified(draftId: string, outcome: VerifyOutcome): Promise<void>;
  handleAdvisorText(advisorUserId: string, text: string): Promise<boolean>;
}

/** 员工在服务群里的发言：交给 zhiban-guard 做红线质检（不落正文） */
export interface StaffQualityMessage {
  msgid: string;
  /** 发言人企微 userid；P1 里即顾问 id */
  from: string;
  roomId: string;
  groupName?: string;
  text: string;
  msgtime: number;
}

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
  /**
   * 员工（顾问 / 客服）在服务群里的发言质检。
   * 只把原文交给质检方做关键词匹配；本运行时日志不会打正文。
   */
  staffQuality?: (message: StaffQualityMessage) => void;
  /**
   * #146：顾问侧边栏的待回复索引。
   * 用 getter 而不是实例：插件装载顺序不同，zhiban-sidebar 可能晚于本插件就绪。
   * 未安装时静默跳过，不影响草稿链路。
   */
  sidebar?: () => SidebarSink | undefined;
  /** 患者域（可选）：存在时由它接管服务群消息 */
  patient?: PatientSink;
  /** 群名与群昵称查询（可选）：未配置凭据或查询失败时静默保留原值 */
  groupInfo?: Pick<GroupInfoClient, 'memberNames' | 'roomInfo'>;
  /** 会话存档同意状态（可选）：查询失败时静默保留原状态 */
  roomAgree?: Pick<RoomAgreeClient, 'roomConsent'>;
  /** #106：客户群自动发现；未配置客户联系凭据时缺省 */
  discovery?: {
    scanOnce(): Promise<unknown>;
    intervalMs: number;
  };
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
  private readonly staffQuality?: (message: StaffQualityMessage) => void;
  private readonly sidebar?: () => SidebarSink | undefined;
  private readonly patient?: PatientSink;
  private readonly groupInfo?: Pick<GroupInfoClient, 'memberNames' | 'roomInfo'>;
  private readonly roomAgree?: Pick<RoomAgreeClient, 'roomConsent'>;
  private readonly discovery?: WecomRuntimeDeps['discovery'];

  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private discoveryTimer?: ReturnType<typeof setInterval>;
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
    this.staffQuality = deps.staffQuality;
    this.sidebar = deps.sidebar;
    this.patient = deps.patient;
    this.groupInfo = deps.groupInfo;
    this.roomAgree = deps.roomAgree;
    this.discovery = deps.discovery;
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
    if (this.discovery) {
      // 启动时先扫一轮，让存量客户群马上出现在待确认里；之后按间隔轮询
      void this.discovery.scanOnce();
      this.discoveryTimer = setInterval(() => {
        void this.discovery?.scanOnce();
      }, this.discovery.intervalMs);
      this.discoveryTimer.unref?.();
      this.log(`服务群自动发现已启动：每 ${this.discovery.intervalMs}ms 扫描一次客户群列表`);
    }
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
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.pollTimer = undefined;
    this.tickTimer = undefined;
    this.discoveryTimer = undefined;
    this.persistProgress(true);
    await this.store.flush();
  }

  /** 拉一轮存档、生成草稿、跑一次队列；测试可直接调用 */
  async pollOnce(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      const result = await this.trigger.pollWithContext();
      this.patient?.observeRooms(await this.enrichRooms(result.rooms));

      // #63：内部员工发言与外部发言按时间交错交给患者域，保证上下文顺序
      const ordered: Array<{ message: ArchivedInbound; event?: (typeof result.events)[number] }> = [
        ...result.internal.map((message) => ({ message })),
        ...result.events.map((event) => ({ message: event.message, event })),
      ].sort((a, b) => a.message.msgtime - b.message.msgtime);

      for (const { message, event } of ordered) {
        // 员工发言先进质检再走上下文：命中红线时仍保留会话上下文，
        // 不因质检拦截而丢失患者域看到的对话顺序。
        if (!event && this.staffQuality && (message.msgtype === 'text' || message.msgtype === undefined)) {
          const text = message.text ?? '';
          if (text.trim() !== '') {
            try {
              this.staffQuality({
                msgid: message.msgid,
                from: message.from,
                roomId: message.roomid,
                groupName: this.store.getGroup(message.roomid)?.name,
                text,
                msgtime: message.msgtime,
              });
            } catch (error) {
              // 质检失败不影响正常会话链路；日志只带 msgid，不带正文
              this.log(
                `员工发言质检失败 msgid=${tailId(message.msgid)}：` +
                  `${error instanceof Error ? error.message : 'UNKNOWN'}`,
              );
            }
          }
        }
        // #146：每条存档消息都进待回复索引。单聊目前被存档适配器过滤
        // （roomid 为空直接丢弃），因此这里只有群会话；单聊支持见 #146 的说明。
        try {
          this.sidebar?.()?.observe({
            msgid: message.msgid,
            convKey: groupConvKey(message.roomid),
            kind: 'group',
            roomId: message.roomid,
            senderId: message.from,
            ...(event ? { senderKind: 'external' as const } : {}),
            msgtype: message.msgtype ?? 'text',
            text: message.text,
            at: message.msgtime,
          });
        } catch (error) {
          // 索引失败不影响主链路；日志只带 msgid
          this.log(
            `待回复索引失败 msgid=${tailId(message.msgid)}：` +
              `${error instanceof Error ? error.message : 'UNKNOWN'}`,
          );
        }
        if (this.patient) {
          const routed = this.patient.routeInbound({
            msgid: message.msgid,
            roomId: message.roomid,
            from: message.from,
            text: message.text,
            msgtime: message.msgtime,
            msgtype: message.msgtype,
            mediaPath: message.mediaPath,
          });
          // 患者域接管（合并窗口 / 上下文 / 未启用）时不走模板草稿
          if (routed.handled) continue;
        }
        if (!event) continue;

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
      await this.observeDmMessages();
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

  /**
   * #159 单聊接入：顾问与客户之间的存档单聊进待回复索引。
   * 只读展示——不生成草稿、不进患者域；待回复索引按 msgid 幂等。
   * 重启后存档缓存清空，停机期间到达的单聊不回补（P1 已知限制）。
   */
  private async observeDmMessages(): Promise<void> {
    const staffUserIds = [this.config.advisorChatId];
    try {
      const until = this.clock.now();
      const dms = await this.archive.listDmMessages({
        staffUserIds,
        since: until - DM_INGEST_LOOKBACK_MS,
        until,
        includeMedia: true,
      });
      for (const message of dms) {
        const fromStaff = staffUserIds.includes(message.from);
        const externalId = fromStaff ? (message.tolist?.[0] ?? '') : message.from;
        if (externalId === '') continue;
        try {
          this.sidebar?.()?.observe({
            msgid: message.msgid,
            convKey: dmConvKey(staffUserIds[0]!, externalId),
            kind: 'dm',
            senderId: message.from,
            // 方向显式给出：classify 的 wm 前缀推断会把 wo 开头的客户误判成员工
            senderKind: fromStaff ? 'staff' : 'external',
            msgtype: message.msgtype ?? 'text',
            text: message.text,
            at: message.msgtime,
          });
        } catch (error) {
          this.log(
            `单聊待回复索引失败 msgid=${tailId(message.msgid)}：` +
              `${error instanceof Error ? error.message : 'UNKNOWN'}`,
          );
        }
      }
    } catch (error) {
      this.log(`单聊索引拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 用客户联系 API 补群名与群昵称，用会话存档 API 补同意状态。
   * 未配置凭据、内部群（90501）或查询失败时原样返回对应字段，
   * 患者域继续用「外部成员 …尾号」/ 原群名与同意状态，不影响草稿链路。
   */
  private async enrichRooms(
    rooms: Array<{
      roomId: string;
      members: Array<{
        id: string;
        isExternal: boolean;
        lastActiveAt: number;
        displayName?: string;
      }>;
    }>,
  ): Promise<
    Array<{
      roomId: string;
      members: Array<{
        id: string;
        isExternal: boolean;
        lastActiveAt: number;
        displayName?: string;
      }>;
      /** 企微里当前的群名；空群名不返回，避免覆盖已有名称 */
      groupName?: string;
      memberNames?: Record<string, string>;
      memberConsent?: Record<string, ConsentStatus>;
    }>
  > {
    const groupInfo = this.groupInfo;
    const roomAgree = this.roomAgree;
    if (!groupInfo && !roomAgree) return rooms;

    return Promise.all(
      rooms.map(async (room) => {
        const [info, consent] = await Promise.all([
          groupInfo ? this.safeRoomInfo(groupInfo, room.roomId) : undefined,
          roomAgree ? this.safeRoomConsent(roomAgree, room.roomId) : undefined,
        ]);
        const hasNames = info !== undefined && info.names.size > 0;
        if (!hasNames && !info?.name && !consent) return room;

        const enriched = { ...room };
        if (hasNames && info) {
          enriched.members = room.members.map((member) => {
            const displayName = info.names.get(member.id);
            return displayName ? { ...member, displayName } : member;
          });
          // 整群映射交给患者域：本轮没发言的成员也能更新名称、回填患者
          Object.assign(enriched, { memberNames: Object.fromEntries(info.names) });
        }
        if (info?.name) Object.assign(enriched, { groupName: info.name });
        if (consent) Object.assign(enriched, { memberConsent: consent });
        return enriched;
      }),
    );
  }

  private async safeRoomInfo(
    client: Pick<GroupInfoClient, 'roomInfo'>,
    roomId: string,
  ): Promise<RoomInfo | undefined> {
    try {
      return await client.roomInfo(roomId);
    } catch {
      return undefined;
    }
  }

  private async safeRoomConsent(
    client: Pick<RoomAgreeClient, 'roomConsent'>,
    roomId: string,
  ): Promise<Record<string, ConsentStatus> | undefined> {
    try {
      return await client.roomConsent(roomId);
    } catch {
      return undefined;
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
        // #34：核验结果作为上下文写回患者长期会话，不唤醒新回合
        if (result.draftId) {
          await this.patient?.handleDraftVerified(result.draftId, result.outcome);
        }
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
      // #56：改稿后旧卡片仍然可见，点旧卡片只提示，不当作错误
      if (message.startsWith('STALE_CARD')) {
        this.log(`过期卡片，忽略（${message}）`);
        await this.notify('这条草稿已有新版本，请使用最新一条卡片操作。');
        return;
      }
      this.log(`确认失败：${message}`);
    }
  }

  /** 顾问在机器人 1:1 里发文字：有活动草稿时作为改稿指令（#56） */
  async handleAdvisorMessage(advisorUserId: string, text: string): Promise<void> {
    if (!this.patient) return;
    try {
      await this.patient.handleAdvisorText(advisorUserId, text);
    } catch (error) {
      this.log(
        `改稿指令处理失败：${error instanceof Error ? error.message : String(error)}`,
      );
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
