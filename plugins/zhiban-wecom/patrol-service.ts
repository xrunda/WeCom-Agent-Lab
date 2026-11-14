/**
 * #161 主动巡检服务：每日一次，把沉默与投诉信号汇总给顾问本人。
 *
 * 数据全部来自已有的会话存档：
 * - 沉默：客户最后发言 ≥ silentDays 天，且顾问同期在该群没有发言；
 * - 投诉：最近 24h 客户消息命中高置信关键词，只记录命中词，不保存原文。
 *
 * 约束：只发顾问 1:1（F1）；不带消息正文；无信号当天不发；
 * 同一客户 14 天内不重复；同一天最多一条汇总。
 */
import { buildPatrolCard } from '../../src/c2/message.ts';
import { isDuplicateSignal, isSilent, matchComplaints } from '../../src/c2/patrol.ts';
import type { DedupeEntry, PatrolSignal } from '../../src/c2/patrol.ts';
import type { ArchivePort, BotPort, Clock } from '../../src/c2/ports.ts';
import type { Alert } from '../../src/c2/types.ts';

const DAY_MS = 24 * 60 * 60_000;
/** 找「最后一次客户发言」的回看窗口；必须远大于 silentDays，否则老群查不到最后一条 */
const LOOKBACK_DAYS = 180;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;

export interface PatrolGroup {
  roomId: string;
  name: string;
  advisorId?: string;
  status?: string;
}

export interface PatrolState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface PatrolConfig {
  silentDays?: number;
  /** 东八区小时/分钟，默认 08:30 */
  digestHour?: number;
  digestMinute?: number;
  maxItems?: number;
  /** 同一客户多少天内不重复 */
  perCustomerDays?: number;
}

export interface PatrolDeps {
  archive: Pick<ArchivePort, 'listInboundMessages' | 'listSentMessages'>;
  bot: BotPort;
  clock: Clock;
  groups: () => PatrolGroup[];
  /** 顾问企微 userid（存档发送者） */
  advisorUserId: string;
  /** 与机器人的 1:1 会话 id */
  advisorChatId: string;
  advisorId: string;
  emitAlert: (alert: Alert) => void;
  state: PatrolState;
  /** 只有具备 patient.read 时才传昵称 */
  patientNameForRoom?: (roomId: string) => string | undefined;
  canReadPatient?: boolean;
  config?: PatrolConfig;
  logger?: (line: string) => void;
}

export const DEFAULT_PATROL_CONFIG: Required<PatrolConfig> = {
  silentDays: 7,
  digestHour: 8,
  digestMinute: 30,
  maxItems: 3,
  perCustomerDays: 14,
};

const STATE_KEY = 'patrol_state';

interface StoredState {
  /** 已发过汇总的日期（东八区 YYYY-MM-DD） */
  digestDay?: string;
  /** 「今天不看」抑制的日期 */
  mutedDay?: string;
  recent: DedupeEntry[];
}

function dayKey(at: number): string {
  return new Date(at + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shanghaiParts(at: number): { hour: number; minute: number } {
  const date = new Date(at + SHANGHAI_OFFSET_MS);
  return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
}

function tail(id: string): string {
  return id.length <= 8 ? id : `…${id.slice(-6)}`;
}

export class PatrolService {
  private readonly deps: PatrolDeps;
  private readonly config: Required<PatrolConfig>;

  constructor(deps: PatrolDeps) {
    this.deps = deps;
    this.config = { ...DEFAULT_PATROL_CONFIG, ...deps.config };
  }

  /** 每分钟可调用；每天只在固定时段真正扫描一次 */
  async run(now = this.deps.clock.now()): Promise<PatrolSignal[]> {
    const today = dayKey(now);
    const state = this.state();
    if (state.digestDay === today) return [];
    const { hour, minute } = shanghaiParts(now);
    if (hour < this.config.digestHour) return [];
    if (hour === this.config.digestHour && minute < this.config.digestMinute) return [];

    const signals = await this.collect(now, state);

    // 先落告警：即使顾问点了「今天不看」，控制台仍应看到信号
    for (const signal of signals) {
      this.deps.emitAlert({
        kind: signal.kind === 'complaint' ? 'PATROL_COMPLAINT' : 'PATROL_SILENT',
        message:
          signal.kind === 'complaint'
            ? `巡检：${signal.groupName} 出现投诉/风险信号（${(signal.keywords ?? []).join('、')}）`
            : `巡检：${signal.groupName} 客户已沉默 ${signal.days} 天`,
        at: now,
        advisorId: signal.advisorId,
      });
      this.log(
        `巡检信号 ${signal.kind} room=${tail(signal.roomId)} days=${signal.days}` +
          `${signal.keywords ? ` keywords=${signal.keywords.length}` : ''}`,
      );
    }

    state.digestDay = today;
    if (signals.length > 0) {
      state.recent = [
        ...state.recent,
        ...signals.map((signal) => ({
          kind: signal.kind,
          roomId: signal.roomId,
          ...(signal.customerId ? { customerId: signal.customerId } : {}),
          at: now,
        })),
      ].filter((entry) => entry.at >= now - 30 * DAY_MS);
    }
    this.saveState(state);

    if (signals.length === 0) return [];
    if (state.mutedDay === today) {
      this.log('巡检汇总已生成，但顾问选择了「今天不看」');
      return [];
    }

    const ranked = signals.slice(0, this.config.maxItems);
    if (this.deps.advisorChatId) {
      try {
        await this.deps.bot.sendCard(
          this.deps.advisorChatId,
          buildPatrolCard(this.deps.advisorId, ranked, signals.length - ranked.length),
        );
        this.log(`巡检汇总已发送 条数=${ranked.length}`);
      } catch (error) {
        this.log(
          `巡检汇总发送失败：${error instanceof Error ? error.message : 'UNKNOWN'}`,
        );
      }
    }
    return signals;
  }

  /** patrol:<advisorId>:show|mute */
  handleButtonKey(key: string): 'show' | 'mute' | undefined {
    const match = /^patrol:([^:]+):(show|mute)$/.exec(key);
    if (!match) return undefined;
    if (match[1] !== this.deps.advisorId) return undefined;
    const action = match[2] as 'show' | 'mute';
    if (action === 'mute') {
      const state = this.state();
      state.mutedDay = dayKey(this.deps.clock.now());
      this.saveState(state);
    }
    this.log(`巡检按钮 ${action}`);
    return action;
  }

  private async collect(now: number, state: StoredState): Promise<PatrolSignal[]> {
    const groups = this.deps.groups().filter(
      (group) => group.status !== 'disabled' && group.advisorId === this.deps.advisorId,
    );
    const signals: PatrolSignal[] = [];
    for (const group of groups) {
      const since = now - LOOKBACK_DAYS * DAY_MS;
      try {
        const [inbound, sent] = await Promise.all([
          this.deps.archive.listInboundMessages({
            roomIds: [group.roomId],
            excludeSender: this.deps.advisorUserId,
            since,
            until: now,
          }),
          this.deps.archive.listSentMessages({
            fromUser: this.deps.advisorUserId,
            since,
            until: now,
          }),
        ]);
        const groupInbound = inbound.filter((message) => message.roomid === group.roomId);
        const lastCustomerAt = groupInbound.reduce(
          (max, message) => Math.max(max, message.msgtime),
          0,
        );
        const lastAdvisorAt = sent
          .filter((message) => message.roomid === group.roomId)
          .reduce((max, message) => Math.max(max, message.msgtime), 0);

        if (lastCustomerAt > 0) {
          const silent = isSilent({
            lastCustomerAt,
            ...(lastAdvisorAt > 0 ? { lastAdvisorAt } : {}),
            now,
            silentDays: this.config.silentDays,
          });
          if (silent) {
            const signal: PatrolSignal = {
              id: `sil_${group.roomId}`,
              kind: 'silent',
              advisorId: this.deps.advisorId,
              roomId: group.roomId,
              groupName: group.name,
              days: Math.max(this.config.silentDays, Math.floor((now - lastCustomerAt) / DAY_MS)),
              at: now,
            };
            const name = this.deps.canReadPatient === false
              ? undefined
              : this.deps.patientNameForRoom?.(group.roomId);
            if (name) signal.customerName = name;
            if (
              !isDuplicateSignal(signal, state.recent, {
                now,
                perCustomerDays: this.config.perCustomerDays,
              })
            ) {
              signals.push(signal);
            }
          }
        }

        // 投诉信号只看最近 24h，避免把几天前的旧消息每天重报
        const recent = groupInbound.filter((message) => message.msgtime >= now - DAY_MS);
        const keywords = new Set<string>();
        let complaintSender: string | undefined;
        for (const message of recent) {
          const hit = matchComplaints(message.text ?? '');
          if (!hit) continue;
          complaintSender ??= message.from;
          for (const keyword of hit.keywords) keywords.add(keyword);
        }
        if (complaintSender !== undefined) {
          const signal: PatrolSignal = {
            id: `cmp_${group.roomId}_${complaintSender}`,
            kind: 'complaint',
            advisorId: this.deps.advisorId,
            roomId: group.roomId,
            groupName: group.name,
            customerId: complaintSender,
            days: 0,
            keywords: [...keywords],
            at: now,
          };
          const name = this.deps.canReadPatient === false
            ? undefined
            : this.deps.patientNameForRoom?.(group.roomId);
          if (name) signal.customerName = name;
          if (
            !isDuplicateSignal(signal, state.recent, {
              now,
              perCustomerDays: this.config.perCustomerDays,
            })
          ) {
            signals.push(signal);
          }
        }
      } catch (error) {
        this.log(
          `巡检读取存档失败 room=${tail(group.roomId)}：` +
            `${error instanceof Error ? error.message : 'UNKNOWN'}`,
        );
      }
    }
    return signals;
  }

  private state(): StoredState {
    const stored = this.deps.state.get<StoredState>(STATE_KEY);
    return { recent: [], ...(stored ?? {}) };
  }

  private saveState(state: StoredState): void {
    this.deps.state.set(STATE_KEY, state);
  }

  private log(line: string): void {
    this.deps.logger?.(line);
  }
}
