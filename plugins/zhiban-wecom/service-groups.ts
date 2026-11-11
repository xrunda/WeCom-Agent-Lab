/**
 * 运行时服务群名单（#106）。
 *
 * 存档接口能看到整个企业的群，但 P1 只处理「本环境允许服务」的群。
 * 名单分两层：
 *   - allowed：允许从存档拉取消息的群（服务中 / 仅采集）；
 *   - known：已发现过的群及状态（候选 / 服务中 / 停用），避免每次扫描都重复登记。
 *
 * profile 的 `serviceGroupRoomIds` 只是初始种子；控制台「开始服务 / 移出服务」
 * 在运行时修改名单并落盘到 zhiban_wecom 的 meta，不需要重启。
 *
 * 约定：
 * - 名单里只有 roomid，不含昵称或消息正文；日志最多打尾号。
 * - 「移出服务」会写 denied，重启后不会被 profile 种子重新加回来。
 * - 存档适配器的过滤函数是同步的，因此这里保持内存镜像，写入串行落盘。
 */

export type ServiceGroupState = 'candidate' | 'active' | 'inactive';

export interface ServiceGroupRosterEntry {
  roomId: string;
  state: ServiceGroupState;
  updatedAt: number;
}

interface KnownEntry {
  state: ServiceGroupState;
  updatedAt: number;
}

/** 持久化结构；向前兼容时按字段容错解析 */
export interface ServiceRosterSnapshot {
  version: 1;
  allowed: string[];
  denied: string[];
  known: Record<string, KnownEntry>;
  updatedAt: number;
}

export interface ServiceGroupRegistryOptions {
  /** profile 里的初始白名单 */
  seedRoomIds: string[];
  /** 上次落盘的名单（DomainStore meta），缺失或损坏时按种子重建 */
  snapshot?: unknown;
  save: (snapshot: ServiceRosterSnapshot) => void;
  now: () => number;
}

const STATES: ServiceGroupState[] = ['candidate', 'active', 'inactive'];

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const set = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed !== '') set.add(trimmed);
  }
  return [...set];
}

function parseSnapshot(value: unknown): ServiceRosterSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<ServiceRosterSnapshot>;
  if (input.version !== 1) return undefined;

  const known: Record<string, KnownEntry> = {};
  if (input.known !== null && typeof input.known === 'object') {
    for (const [roomId, entry] of Object.entries(input.known)) {
      if (roomId.trim() === '') continue;
      if (entry === null || typeof entry !== 'object') continue;
      const state = (entry as KnownEntry).state;
      if (!STATES.includes(state)) continue;
      const updatedAt =
        typeof (entry as KnownEntry).updatedAt === 'number'
          ? (entry as KnownEntry).updatedAt
          : 0;
      known[roomId] = { state, updatedAt };
    }
  }

  return {
    version: 1,
    allowed: stringList(input.allowed),
    denied: stringList(input.denied),
    known,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : 0,
  };
}

export class ServiceGroupRegistry {
  private readonly seedRoomIds: string[];
  private readonly seedSet: Set<string>;
  private readonly allowed = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly known = new Map<string, KnownEntry>();
  private readonly save: (snapshot: ServiceRosterSnapshot) => void;
  private readonly now: () => number;

  constructor(options: ServiceGroupRegistryOptions) {
    this.seedRoomIds = stringList(options.seedRoomIds);
    this.seedSet = new Set(this.seedRoomIds);
    this.save = options.save;
    this.now = options.now;

    const snapshot = parseSnapshot(options.snapshot);
    if (snapshot) {
      for (const roomId of snapshot.allowed) this.allowed.add(roomId);
      for (const roomId of snapshot.denied) this.denied.add(roomId);
      for (const [roomId, entry] of Object.entries(snapshot.known)) {
        this.known.set(roomId, entry);
      }
    }
  }

  /** 存档过滤：本轮允许拉取消息的群 */
  isAllowed(roomId: string): boolean {
    if (this.denied.has(roomId)) return false;
    return this.allowed.has(roomId) || this.seedSet.has(roomId);
  }

  /** 动态名单；每次轮询都会重新取，运行时新增的群无需重启 */
  roomIds(): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const roomId of [...this.seedRoomIds, ...this.allowed]) {
      if (this.denied.has(roomId) || seen.has(roomId)) continue;
      seen.add(roomId);
      result.push(roomId);
    }
    return result;
  }

  /** 是否已经发现过（候选 / 服务中 / 停用 / 忽略） */
  isKnown(roomId: string): boolean {
    return this.isAllowed(roomId) || this.known.has(roomId);
  }

  stateOf(roomId: string): ServiceGroupState | undefined {
    return this.known.get(roomId)?.state;
  }

  entries(): ServiceGroupRosterEntry[] {
    const rows = new Map<string, ServiceGroupRosterEntry>();
    for (const roomId of this.roomIds()) {
      rows.set(roomId, { roomId, state: 'active', updatedAt: this.known.get(roomId)?.updatedAt ?? 0 });
    }
    for (const [roomId, entry] of this.known) {
      const existing = rows.get(roomId);
      if (existing) {
        existing.state = entry.state;
        existing.updatedAt = entry.updatedAt;
        continue;
      }
      rows.set(roomId, { roomId, state: entry.state, updatedAt: entry.updatedAt });
    }
    return [...rows.values()];
  }

  /** 仅候选群（发现任务要刷新群名与成员） */
  candidateRoomIds(): string[] {
    const result: string[] = [];
    for (const [roomId, entry] of this.known) {
      if (entry.state === 'candidate' && !this.denied.has(roomId)) result.push(roomId);
    }
    return result;
  }

  /**
   * 登记刚发现的群，返回本次新登记的 roomid。
   * 批量写入只落盘一次，避免一次扫描写几十次。
   */
  markCandidates(roomIds: string[]): string[] {
    const at = this.now();
    const added: string[] = [];
    for (const roomId of roomIds) {
      if (roomId.trim() === '' || this.isKnown(roomId)) continue;
      this.known.set(roomId, { state: 'candidate', updatedAt: at });
      added.push(roomId);
    }
    if (added.length > 0) this.persist(at);
    return added;
  }

  /** 控制台「开始服务」：加入存档白名单并标记为服务中 */
  activate(roomId: string): void {
    if (roomId.trim() === '') return;
    this.denied.delete(roomId);
    this.allowed.add(roomId);
    this.known.set(roomId, { state: 'active', updatedAt: this.now() });
    this.persist(this.now());
  }

  /** 控制台「移出服务」：停止拉取该群消息，重启后仍保持停用 */
  deactivate(roomId: string): void {
    if (roomId.trim() === '') return;
    this.allowed.delete(roomId);
    this.denied.add(roomId);
    this.known.set(roomId, { state: 'inactive', updatedAt: this.now() });
    this.persist(this.now());
  }

  snapshot(): ServiceRosterSnapshot {
    const known: Record<string, KnownEntry> = {};
    for (const [roomId, entry] of this.known) known[roomId] = { ...entry };
    return {
      version: 1,
      allowed: [...this.allowed],
      denied: [...this.denied],
      known,
      updatedAt: this.now(),
    };
  }

  private persist(at: number): void {
    this.save({ ...this.snapshot(), updatedAt: at });
  }
}
