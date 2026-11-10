#!/usr/bin/env node
/**
 * #60 上线：把演示群从 pending 改为 serving（或 collect_only / disabled）。
 *
 * 只调用控制台公开接口 `/zhiban/api/groups`，不直写 DSH 存储、不读取数据库。
 * 账号密码来自命令行或环境变量，不落盘、不打印；密码错误只给出固定提示。
 *
 * 用法：
 *   npm run group:status -- --list
 *   npm run group:status -- --room-id wr... --status serving
 *   npm run group:status -- --name 陈嘉禾 --status serving --dry-run
 *
 * 环境变量：ZHIBAN_CONSOLE_BASE_URL / ZHIBAN_CONSOLE_USERNAME / ZHIBAN_CONSOLE_PASSWORD
 */

interface GroupView {
  id: string;
  roomId: string;
  name: string;
  status: 'pending' | 'serving' | 'collect_only' | 'disabled';
  advisorId?: string;
  demo: boolean;
  memberCount: number;
  externalMemberCount: number;
  lastActiveAt?: number;
}

interface UpdatePatch {
  name?: string;
  status?: GroupView['status'];
  advisorId?: string;
}

interface Options {
  baseUrl: string;
  username: string;
  password: string;
  groupId?: string;
  roomId?: string;
  name?: string;
  status?: GroupView['status'];
  list: boolean;
  dryRun: boolean;
  timeoutMs: number;
}

const GROUP_STATUSES = ['pending', 'serving', 'collect_only', 'disabled'] as const;

const USAGE = `用法：
  npm run group:status -- --list
  npm run group:status -- --room-id <roomid> --status serving
  npm run group:status -- --name <群名> --status serving
  npm run group:status -- --group-id <grp_...> --status collect_only

选项：
  --base-url <url>    控制台地址（默认 ZHIBAN_CONSOLE_BASE_URL）
  --username <name>   登录账号（默认 ZHIBAN_CONSOLE_USERNAME）
  --password <pass>   登录密码（默认 ZHIBAN_CONSOLE_PASSWORD）
  --list              只列出群，不改状态
  --dry-run           只打印将要修改的内容，不提交
  --status <status>   pending | serving | collect_only | disabled
  --group-id <id>     按内部群 id 匹配
  --room-id <roomid>  按存档 roomid 匹配
  --name <name>       按群名匹配（先精确，再唯一包含）
  --timeout-ms <ms>   请求超时，默认 30000

说明：真实播种前，把演示群改为 serving；未匹配到或多个匹配时会报错，不会批量修改。`;

class UsageError extends Error {}

class ConsoleHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ConsoleHttpError';
    this.status = status;
    this.code = code;
  }
}

function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new UsageError('缺少控制台地址');
  return trimmed.endsWith('/zhiban/api') ? trimmed : `${trimmed}/zhiban/api`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} 缺少取值`);
  return value;
}

function parseStatus(raw: string): GroupView['status'] {
  if ((GROUP_STATUSES as readonly string[]).includes(raw)) {
    return raw as GroupView['status'];
  }
  throw new UsageError(`status 必须是 ${GROUP_STATUSES.join(' / ')}`);
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    baseUrl: env.ZHIBAN_CONSOLE_BASE_URL ?? '',
    username: env.ZHIBAN_CONSOLE_USERNAME ?? '',
    password: env.ZHIBAN_CONSOLE_PASSWORD ?? '',
    list: false,
    dryRun: false,
    timeoutMs: 30_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
      case '--base-url':
        options.baseUrl = requireValue(argv, ++i, arg);
        break;
      case '--username':
        options.username = requireValue(argv, ++i, arg);
        break;
      case '--password':
        options.password = requireValue(argv, ++i, arg);
        break;
      case '--group-id':
        options.groupId = requireValue(argv, ++i, arg);
        break;
      case '--room-id':
        options.roomId = requireValue(argv, ++i, arg);
        break;
      case '--name':
        options.name = requireValue(argv, ++i, arg);
        break;
      case '--status':
        options.status = parseStatus(requireValue(argv, ++i, arg));
        break;
      case '--timeout-ms': {
        const value = Number(requireValue(argv, ++i, arg));
        if (!Number.isFinite(value) || value <= 0) throw new UsageError('--timeout-ms 必须是正数');
        options.timeoutMs = value;
        break;
      }
      case '--list':
        options.list = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new UsageError(`未知参数：${arg}`);
    }
  }

  if (!options.list && !options.status) {
    throw new UsageError('修改状态时必须提供 --status；只查看请加 --list');
  }
  if (!options.baseUrl || !options.username || !options.password) {
    throw new UsageError(
      '缺少控制台地址或账号：请设置 ZHIBAN_CONSOLE_BASE_URL / ZHIBAN_CONSOLE_USERNAME / ' +
        'ZHIBAN_CONSOLE_PASSWORD，或用 --base-url / --username / --password。',
    );
  }
  return options;
}

class ConsoleClient {
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private cookie = '';

  constructor(baseUrl: string, timeoutMs: number) {
    this.apiBase = normalizeApiBase(baseUrl);
    this.timeoutMs = timeoutMs;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      let message = `请求失败（${res.status}）`;
      try {
        const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // 非 JSON 错误体，保留状态码
      }
      throw new ConsoleHttpError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  async login(username: string, password: string): Promise<void> {
    const res = await this.request('POST', '/auth/login', { username, password });
    if (!res.ok) {
      throw new ConsoleHttpError(res.status, 'LOGIN_FAILED', '登录失败，请检查账号或密码');
    }
    const cookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const raw =
      cookies.find((item) => item.startsWith('zhiban_session=')) ??
      res.headers.get('set-cookie') ??
      '';
    const match = raw.match(/zhiban_session=([^;]+)/);
    if (!match) throw new ConsoleHttpError(500, 'NO_SESSION_COOKIE', '登录成功但未拿到会话 cookie');
    this.cookie = `zhiban_session=${match[1]}`;
  }

  async listGroups(): Promise<GroupView[]> {
    // 控制台 pageSize 上限 100，逐页取完，避免群多于 100 时漏掉目标
    const all: GroupView[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const body = await this.json<{ items: GroupView[]; total: number }>(
        'GET',
        `/groups?page=${page}&pageSize=100`,
      );
      all.push(...body.items);
      if (body.items.length === 0 || all.length >= body.total) break;
    }
    return all;
  }

  async updateGroup(groupId: string, patch: UpdatePatch): Promise<GroupView> {
    return this.json<GroupView>('PATCH', `/groups/${encodeURIComponent(groupId)}`, patch);
  }
}

function pickGroup(groups: GroupView[], options: Options): GroupView {
  const match = (group: GroupView): boolean => {
    if (options.groupId) return group.id === options.groupId;
    if (options.roomId) return group.roomId === options.roomId;
    if (options.name) return group.name === options.name;
    return false;
  };
  let matches = groups.filter(match);

  if (options.name && matches.length === 0) {
    matches = groups.filter((group) => group.name.includes(options.name!));
  }

  if (matches.length === 0) {
    throw new UsageError('没有匹配的群；请先用 --list 查看');
  }
  if (matches.length > 1) {
    console.error('匹配到多个群，请改用 --group-id 或 --room-id：');
    for (const group of matches) printGroup(group);
    throw new UsageError('匹配不唯一，未修改任何群');
  }
  return matches[0]!;
}

function printGroup(group: GroupView): void {
  const advisor = group.advisorId ?? '-';
  console.log(
    `${group.id}  ${group.status.padEnd(12)}  ${group.name}  ` +
      `room=${group.roomId}  demo=${group.demo ? 'yes' : 'no'}  advisor=${advisor}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  const client = new ConsoleClient(options.baseUrl, options.timeoutMs);
  await client.login(options.username, options.password);

  const groups = await client.listGroups();

  if (options.list) {
    const filtered = options.status
      ? groups.filter((group) => group.status === options.status)
      : groups;
    if (filtered.length === 0) {
      console.log('没有群。确认 demo 实例已轮询到存档，且 roomid 在白名单内。');
      return;
    }
    for (const group of filtered) printGroup(group);
    console.log(`共 ${filtered.length} 个群。`);
    return;
  }

  const target = pickGroup(groups, options);
  const status = options.status!;
  if (target.status === status) {
    console.log(`无需修改：${target.name} 已经是 ${status}`);
    return;
  }

  if (options.dryRun) {
    console.log(`将把 ${target.name}（${target.id}）从 ${target.status} 改为 ${status}`);
    return;
  }

  const updated = await client.updateGroup(target.id, { status });
  console.log(`已更新：${updated.name}（${updated.id}）→ ${updated.status}`);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (error instanceof ConsoleHttpError) {
    console.error(`${error.code}：${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
