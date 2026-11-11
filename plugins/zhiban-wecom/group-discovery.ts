/**
 * 服务群自动发现（#106）。
 *
 * 只发现「企业创建的客户群」：数据源是客户联系 API 的
 * externalcontact/groupchat/list，而不是全部存档 roomid。
 * 配置 `ownerUserIds` 后只登记本环境群主名下的群，避免共用 corpid 的
 * demo / dev 互相看到对方的客户群。
 * 新群自动登记为候选（pending），但必须由管理员在控制台点「开始服务」
 * 才会进入存档白名单并生成草稿。
 *
 * 约束：
 * - 群名与成员昵称是个人信息：只交给患者域，不写日志、不进错误信息。
 * - 任何接口失败都不阻塞存档轮询；本轮跳过，下一轮再试。
 * - 已忽略 / 已停用的群不会被再次登记。
 */
import { tailId } from '../../src/c2/redact.ts';

import type { GroupInfoClient, RoomInfo } from './group-info.ts';
import type { ServiceGroupRegistry } from './service-groups.ts';

/** 发现任务只需要患者域的这一项能力；未就绪时返回 undefined */
export interface DiscoveryPatientSink {
  observeRooms(
    rooms: Array<{
      roomId: string;
      members: Array<{
        id: string;
        isExternal: boolean;
        lastActiveAt: number;
        displayName?: string;
      }>;
      groupName?: string;
      memberNames?: Record<string, string>;
    }>,
  ): void;
}

export interface GroupDiscoveryOptions {
  client: Pick<GroupInfoClient, 'listCustomerGroups' | 'roomInfo'>;
  registry: ServiceGroupRegistry;
  /** 懒取患者域：插件加载顺序不固定，每次扫描时再取 */
  patient: () => DiscoveryPatientSink | undefined;
  now: () => number;
  logger?: (line: string) => void;
  /** 单轮最多处理多少个群（含新增与刷新），避免一次拉太多接口 */
  maxPerScan?: number;
  /**
   * 只发现这些群主（企微 userid）名下的客户群，经列表接口 `owner_filter` 过滤。
   * 两个环境共用同一个 corpid，配置本环境的顾问后，另一个环境的群不会被登记。
   * 空数组表示不按群主过滤。
   */
  ownerUserIds?: string[];
}

export interface DiscoveryResult {
  /** 接口返回且通过群主过滤的客户群数量；接口失败为 0 */
  listed: number;
  /** 本轮新登记的候选数 */
  added: number;
  /** 本轮刷新了群名/成员的候选数 */
  refreshed: number;
  /** 已忽略 / 服务中 / 停用而跳过的数量 */
  skipped: number;
}

const DEFAULT_MAX_PER_SCAN = 50;

export class GroupDiscovery {
  private readonly client: Pick<GroupInfoClient, 'listCustomerGroups' | 'roomInfo'>;
  private readonly registry: ServiceGroupRegistry;
  private readonly patient: () => DiscoveryPatientSink | undefined;
  private readonly now: () => number;
  private readonly logger?: (line: string) => void;
  private readonly maxPerScan: number;
  private readonly ownerUserIds: string[];

  private scanning = false;

  constructor(options: GroupDiscoveryOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.patient = options.patient;
    this.now = options.now;
    this.logger = options.logger;
    this.maxPerScan = options.maxPerScan ?? DEFAULT_MAX_PER_SCAN;
    // 群主过滤交给企微列表接口（owner_filter）；响应里没有群主字段
    this.ownerUserIds = (options.ownerUserIds ?? []).filter((owner) => owner.trim() !== '');
  }

  /**
   * 扫一轮客户群列表。
   * 返回统计而非抛错：调用方（定时器）不需要处理异常。
   */
  async scanOnce(): Promise<DiscoveryResult> {
    const empty: DiscoveryResult = { listed: 0, added: 0, refreshed: 0, skipped: 0 };
    if (this.scanning) return empty;
    this.scanning = true;
    try {
      // ownerUserIds 非空时由企微按群主过滤（owner_filter），响应不含群主字段
      const listed = await this.client.listCustomerGroups(this.ownerUserIds);
      if (!listed) return empty;

      const listedIds = new Set(listed.map((item) => item.chatId));
      const skipped = listed.filter((item) => this.registry.isKnown(item.chatId)).length;

      const freshIds: string[] = [];
      for (const item of listed) {
        if (freshIds.length >= this.maxPerScan) break;
        if (this.registry.isKnown(item.chatId)) continue;
        freshIds.push(item.chatId);
      }
      const addedIds = this.registry.markCandidates(freshIds);

      // 候选群每轮都刷新群名与成员（groupchat/get 自带 10 分钟缓存）
      const refreshTargets = new Set(addedIds);
      for (const roomId of this.registry.candidateRoomIds()) {
        if (refreshTargets.size >= this.maxPerScan) break;
        if (listedIds.has(roomId)) refreshTargets.add(roomId);
      }

      let refreshed = 0;
      const patient = this.patient();
      for (const chatId of refreshTargets) {
        const ok = await this.refreshCandidate(chatId, patient);
        if (ok) refreshed += 1;
      }

      if (patient === undefined && addedIds.length > 0) {
        this.log(`发现 ${addedIds.length} 个候选群，但患者域未就绪，下轮重试`);
      }
      this.log(
        `服务群发现：列出 ${listed.length}，新增 ${addedIds.length}，刷新 ${refreshed}，跳过 ${skipped}`,
      );
      return { listed: listed.length, added: addedIds.length, refreshed, skipped };
    } catch (error) {
      this.log(
        `服务群发现失败：${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return empty;
    } finally {
      this.scanning = false;
    }
  }

  /** 把候选群交给患者域（pending）；失败只影响本轮，不取消候选登记 */
  private async refreshCandidate(
    roomId: string,
    patient: DiscoveryPatientSink | undefined,
  ): Promise<boolean> {
    if (!patient) return false;

    let info: RoomInfo | undefined;
    try {
      info = await this.client.roomInfo(roomId);
    } catch (error) {
      this.log(
        `候选群信息查询异常 room=${tailId(roomId)}：` +
          `${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
    }

    const payload = {
      roomId,
      members:
        info?.members?.map((member) => ({
          id: member.userId,
          isExternal: member.isExternal,
          lastActiveAt: 0,
          ...(member.name ? { displayName: member.name } : {}),
        })) ?? [],
      ...(info?.name ? { groupName: info.name } : {}),
      ...(info && info.names.size > 0
        ? { memberNames: Object.fromEntries(info.names) }
        : {}),
    };

    try {
      patient.observeRooms([payload]);
      return true;
    } catch (error) {
      this.log(
        `候选群登记失败 room=${tailId(roomId)}：` +
          `${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return false;
    }
  }

  private log(line: string): void {
    this.logger?.(line);
  }
}
