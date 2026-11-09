/**
 * zhiban-knowledge 插件配置（#38）。
 *
 * skillDir 指向生成知识 skill 的目录；DSH profile 需要把同一目录
 * 加进 `customSkillDirs`，Agent 才能发现这些文件。
 * 相对路径按 workspaceRoot（默认进程工作目录）解析。
 */
import { isAbsolute, resolve } from 'node:path';

export interface KnowledgePluginConfigInput {
  tenantId?: unknown;
  skillDir?: unknown;
  workspaceRoot?: unknown;
  seedExamples?: unknown;
}

export interface KnowledgePluginConfig {
  tenantId: string;
  /** 绝对路径 */
  skillDir: string;
  seedExamples: boolean;
}

export class KnowledgeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KnowledgeConfigError';
    this.code = code;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KnowledgeConfigError('CONFIG_REQUIRED', `缺少配置项 ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new KnowledgeConfigError('CONFIG_INVALID', `${field} 必须是字符串`);
  }
  return value.trim() || undefined;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new KnowledgeConfigError('CONFIG_INVALID', `${field} 必须是布尔值`);
  }
  return value;
}

export function parseKnowledgeConfig(raw: unknown): KnowledgePluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KnowledgeConfigError('CONFIG_INVALID', '插件配置必须是对象');
  }
  const input = raw as KnowledgePluginConfigInput;
  const skillDir = requiredString(input.skillDir, 'skillDir');
  const workspaceRoot = optionalString(input.workspaceRoot, 'workspaceRoot') ?? process.cwd();
  return {
    tenantId: requiredString(input.tenantId, 'tenantId'),
    skillDir: isAbsolute(skillDir) ? skillDir : resolve(workspaceRoot, skillDir),
    seedExamples: bool(input.seedExamples, 'seedExamples', true),
  };
}
