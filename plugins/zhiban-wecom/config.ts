/**
 * zhiban-wecom 插件配置解析与启动保护（#32 / #65）。
 *
 * 约定：
 * - 配置来自 DSH profile 的插件配置，不从代码里读死值。
 * - 本模块只做校验与归一化，不打印任何 Secret / Token。
 * - dev 环境如果误用了 demo 机器人的 BOT_ID，直接拒绝启动（F14）。
 */

export type ZhibanEnv = 'demo' | 'dev';

export interface WecomPluginConfigInput {
  environment?: unknown;
  demoBotId?: unknown;
  botId?: unknown;
  botSecret?: unknown;
  archive?: {
    binaryPath?: unknown;
    privateKeyPath?: unknown;
    configPath?: unknown;
    batchSize?: unknown;
    maxBatchesPerPoll?: unknown;
    cacheLimit?: unknown;
  };
  serviceGroupRoomIds?: unknown;
  advisorId?: unknown;
  advisorName?: unknown;
  advisorChatId?: unknown;
  groupName?: unknown;
  groupChatId?: unknown;
  mediaRootDir?: unknown;
  pollIntervalMs?: unknown;
  tickIntervalMs?: unknown;
  downtimeThresholdMs?: unknown;
  composeTemplate?: unknown;
}

export interface WecomPluginConfig {
  environment: ZhibanEnv;
  demoBotId: string;
  botId: string;
  botSecret: string;
  archive: {
    binaryPath: string;
    privateKeyPath: string;
    configPath: string;
    batchSize: number;
    maxBatchesPerPoll: number;
    cacheLimit: number;
  };
  /** 本环境允许处理的存档群；两个环境共用存档席位，靠白名单隔离 */
  serviceGroupRoomIds: string[];
  advisorId: string;
  advisorName: string;
  advisorChatId: string;
  groupName: string;
  groupChatId?: string;
  mediaRootDir: string;
  pollIntervalMs: number;
  tickIntervalMs: number;
  downtimeThresholdMs: number;
  composeTemplate?: string;
}

export class WecomConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WecomConfigError';
    this.code = code;
  }
}

const DEFAULTS = {
  pollIntervalMs: 5_000,
  tickIntervalMs: 5_000,
  downtimeThresholdMs: 10 * 60_000,
  batchSize: 100,
  maxBatchesPerPoll: 5,
  cacheLimit: 2000,
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WecomConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new WecomConfigError('CONFIG_INVALID', `${field} 必须是字符串`);
  }
  return value.trim() || undefined;
}

function boundedInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new WecomConfigError('CONFIG_INVALID', `${field} 需为 ${min}–${max} 的整数`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new WecomConfigError('CONFIG_INVALID', `${field} 必须是数组`);
  }
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '');
  const unique = [...new Set(items)];
  if (unique.length === 0) {
    throw new WecomConfigError('CONFIG_REQUIRED', `${field} 至少需要一项`);
  }
  return unique;
}

function parseEnvironment(value: unknown): ZhibanEnv {
  if (value !== 'demo' && value !== 'dev') {
    throw new WecomConfigError('CONFIG_INVALID', 'environment 必须是 demo 或 dev');
  }
  return value;
}

/**
 * 解析插件配置。
 * @param raw DSH 传入的插件配置（未经 schema 校验时也能给出可读错误）
 * @param env 进程环境，用于 `ZHIBAN_ENV` 一致性检查
 */
export function parsePluginConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): WecomPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WecomConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as WecomPluginConfigInput;

  const environment = parseEnvironment(input.environment);
  const envOverride = (env.ZHIBAN_ENV ?? '').trim();
  if (envOverride !== '' && envOverride !== environment) {
    throw new WecomConfigError(
      'ENV_MISMATCH',
      `进程环境 ZHIBAN_ENV=${envOverride} 与插件配置 environment=${environment} 不一致`,
    );
  }

  const demoBotId = requiredString(input.demoBotId, 'demoBotId');
  const botId = requiredString(input.botId, 'botId');
  const botSecret = requiredString(input.botSecret, 'botSecret');

  // F14：dev 误用 demo 机器人会互相踢掉长连接，直接拒绝启动
  if (environment === 'dev' && botId === demoBotId) {
    throw new WecomConfigError(
      'ENV_BOT_CONFLICT',
      'dev 环境不能使用 demo 机器人的 BOT_ID；请在企微后台创建「知伴-开发」机器人并使用其凭据',
    );
  }

  if (input.archive === undefined || typeof input.archive !== 'object') {
    throw new WecomConfigError('CONFIG_REQUIRED', '缺少配置项 archive');
  }
  const archive = input.archive;

  const config: WecomPluginConfig = {
    environment,
    demoBotId,
    botId,
    botSecret,
    archive: {
      binaryPath: requiredString(archive.binaryPath, 'archive.binaryPath'),
      privateKeyPath: requiredString(archive.privateKeyPath, 'archive.privateKeyPath'),
      configPath: requiredString(archive.configPath, 'archive.configPath'),
      batchSize: boundedInt(archive.batchSize, 'archive.batchSize', 1, 1000, DEFAULTS.batchSize),
      maxBatchesPerPoll: boundedInt(
        archive.maxBatchesPerPoll,
        'archive.maxBatchesPerPoll',
        1,
        20,
        DEFAULTS.maxBatchesPerPoll,
      ),
      cacheLimit: boundedInt(archive.cacheLimit, 'archive.cacheLimit', 100, 20_000, DEFAULTS.cacheLimit),
    },
    serviceGroupRoomIds: stringList(input.serviceGroupRoomIds, 'serviceGroupRoomIds'),
    advisorId: requiredString(input.advisorId, 'advisorId'),
    advisorName: requiredString(input.advisorName, 'advisorName'),
    advisorChatId: requiredString(input.advisorChatId, 'advisorChatId'),
    groupName: requiredString(input.groupName, 'groupName'),
    groupChatId: optionalString(input.groupChatId, 'groupChatId'),
    mediaRootDir: requiredString(input.mediaRootDir, 'mediaRootDir'),
    pollIntervalMs: boundedInt(input.pollIntervalMs, 'pollIntervalMs', 1_000, 300_000, DEFAULTS.pollIntervalMs),
    tickIntervalMs: boundedInt(input.tickIntervalMs, 'tickIntervalMs', 1_000, 60_000, DEFAULTS.tickIntervalMs),
    downtimeThresholdMs: boundedInt(
      input.downtimeThresholdMs,
      'downtimeThresholdMs',
      60_000,
      24 * 60 * 60_000,
      DEFAULTS.downtimeThresholdMs,
    ),
    composeTemplate: optionalString(input.composeTemplate, 'composeTemplate'),
  };

  return config;
}

/** 当前环境允许处理的群集合，供 archive 适配器做隐私过滤 */
export function serviceGroupFilter(config: WecomPluginConfig): (roomId: string) => boolean {
  const allowed = new Set(config.serviceGroupRoomIds);
  return (roomId: string) => allowed.has(roomId);
}
