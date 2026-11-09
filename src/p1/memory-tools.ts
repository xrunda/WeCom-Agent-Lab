/**
 * #35 memory_write / memory_update / memory_list 的参数校验与 DSH 定义。
 *
 * 与 reply_draft 的差别：记忆工具在任意回合都可调用，但必须能解析出
 * 当前会话对应的患者；解析不到时明确报错，避免写进错误患者。
 */
import type { RegisteredTool } from './reply-tools.ts';
import {
  MEMORY_CATEGORIES,
  MEMORY_SUBJECTS,
  MEMORY_CONTENT_MAX,
  type MemoryCategory,
  type MemoryRecord,
  type MemorySubject,
} from './memory.ts';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface MemoryWriteArgs {
  category: MemoryCategory;
  content: string;
  subject: MemorySubject;
  sourceText?: string;
}

export interface MemoryUpdateArgs {
  id: string;
  category?: MemoryCategory;
  content?: string;
  subject?: MemorySubject;
}

export interface MemoryListArgs {
  category?: MemoryCategory;
}

function category(value: unknown, field: string, violations: string[]): MemoryCategory | undefined {
  if (value === undefined) return undefined;
  if (!MEMORY_CATEGORIES.includes(value as MemoryCategory)) {
    violations.push(`${field} 必须是 ${MEMORY_CATEGORIES.join('/')}`);
    return undefined;
  }
  return value as MemoryCategory;
}

function subject(value: unknown, field: string, violations: string[]): MemorySubject | undefined {
  if (value === undefined) return undefined;
  if (!MEMORY_SUBJECTS.includes(value as MemorySubject)) {
    violations.push(`${field} 必须是 ${MEMORY_SUBJECTS.join('/')}`);
    return undefined;
  }
  return value as MemorySubject;
}

function content(value: unknown, violations: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    violations.push('content 不能为空');
    return undefined;
  }
  const text = value.trim();
  if (text.length > MEMORY_CONTENT_MAX) {
    violations.push(`content 不能超过 ${MEMORY_CONTENT_MAX} 字`);
    return undefined;
  }
  return text;
}

export function validateMemoryWrite(args: unknown): ValidationResult<MemoryWriteArgs> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const parsedCategory = category(args.category, 'category', violations);
  const parsedContent = content(args.content, violations);
  const parsedSubject = subject(args.subject, 'subject', violations);
  if (!parsedCategory) violations.push('category 必填');
  if (!parsedSubject) violations.push('subject 必填');
  if (args.sourceText !== undefined && typeof args.sourceText !== 'string') {
    violations.push('sourceText 必须是字符串');
  }
  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: {
      category: parsedCategory!,
      content: parsedContent!,
      subject: parsedSubject!,
      sourceText:
        typeof args.sourceText === 'string' ? args.sourceText.trim().slice(0, 100) : undefined,
    },
  };
}

export function validateMemoryUpdate(args: unknown): ValidationResult<MemoryUpdateArgs> {
  const violations: string[] = [];
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id === '') violations.push('id 不能为空');
  const parsedCategory = category(args.category, 'category', violations);
  const parsedSubject = subject(args.subject, 'subject', violations);
  const parsedContent = args.content === undefined ? undefined : content(args.content, violations);
  if (
    args.category === undefined &&
    args.content === undefined &&
    args.subject === undefined
  ) {
    violations.push('至少提供 category / content / subject 之一');
  }
  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: {
      id,
      category: parsedCategory,
      content: parsedContent,
      subject: parsedSubject,
    },
  };
}

export function validateMemoryList(args: unknown): ValidationResult<MemoryListArgs> {
  const violations: string[] = [];
  if (args === undefined || args === null) return { ok: true, value: {} };
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const parsedCategory = category(args.category, 'category', violations);
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { category: parsedCategory } };
}

const STRING = { type: 'string' } as const;

export const MEMORY_WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: [...MEMORY_CATEGORIES],
      description: '记忆分类；过敏/忌口用 dietary_taboo，家庭情况用 family',
    },
    content: { type: 'string', description: '一句话事实，只写明确说过的，不超过 200 字' },
    subject: {
      type: 'string',
      enum: [...MEMORY_SUBJECTS],
      description: '这条事实属于谁：本人 self / 家属 family / 不确定 unknown',
    },
    sourceText: { type: 'string', description: '原话摘要，不超过 100 字' },
  },
  required: ['category', 'content', 'subject'],
  additionalProperties: false,
} as const;

export const MEMORY_UPDATE_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '要修改的记忆 id（mem_...）' },
    category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
    content: { type: 'string', description: '修正后的事实，不超过 200 字' },
    subject: { type: 'string', enum: [...MEMORY_SUBJECTS] },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

export const MEMORY_LIST_PARAMETERS = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: '只看某一分类' },
  },
  additionalProperties: false,
} as const;

export interface MemoryToolContext {
  patientId: string;
  /** 本条事实来自哪条存档消息；主动回合 / 改稿时为空 */
  sourceMsgId?: string;
  /** 发言人角色推出的默认 subject */
  defaultSubject: MemorySubject;
}

export interface MemoryToolHandlers {
  contextForSession(sessionId: string): MemoryToolContext | undefined;
  write(
    sessionId: string,
    input: MemoryWriteArgs & { subject: MemorySubject; sourceMsgId?: string },
  ): MemoryRecord;
  update(sessionId: string, input: MemoryUpdateArgs): MemoryRecord;
  list(sessionId: string, input: MemoryListArgs): MemoryRecord[];
}

function toolError(violations: string[]): never {
  throw new Error(`INVALID_TOOL_ARGS ${violations.join('; ')}`);
}

function sessionOf(exec: { agent?: { id: string } }): string {
  const sessionId = exec.agent?.id;
  if (!sessionId) toolError(['没有关联的 Agent 会话']);
  return sessionId;
}

function requireContext(handlers: MemoryToolHandlers, sessionId: string): MemoryToolContext {
  const context = handlers.contextForSession(sessionId);
  if (!context) toolError(['当前会话没有关联患者，不能读写记忆']);
  return context;
}

const WRITE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    category: { type: 'string' },
    subject: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['id', 'category', 'subject', 'content'],
  additionalProperties: false,
} as const;

const LIST_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          subject: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['id', 'category', 'subject', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

function view(record: MemoryRecord) {
  return {
    id: record.id,
    category: record.category,
    subject: record.subject,
    content: record.content,
  };
}

export function buildMemoryToolDefinitions(handlers: MemoryToolHandlers): RegisteredTool[] {
  return [
    {
      name: 'memory_write',
      description:
        '记录一条患者长期记忆。只记录用户明确说过的稳定事实（过敏、忌口、作息、目标、身体状况、家庭情况、偏好），不记录推断和寒暄。',
      parameters: MEMORY_WRITE_PARAMETERS,
      output: {
        schema: WRITE_RESULT_SCHEMA,
        render: (_args, value) => [
          { type: 'text', text: `已记住：${(value as { content: string }).content}` },
        ],
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = sessionOf(exec);
        const parsed = validateMemoryWrite(args);
        if (!parsed.ok) toolError(parsed.violations);
        const context = requireContext(handlers, sessionId);
        const record = handlers.write(sessionId, {
          ...parsed.value,
          sourceMsgId: context.sourceMsgId,
        });
        return view(record);
      },
    },
    {
      name: 'memory_update',
      description: '修正一条已记录的患者记忆。患者改口或发现记错时使用；不能跨患者修改。',
      parameters: MEMORY_UPDATE_PARAMETERS,
      output: {
        schema: WRITE_RESULT_SCHEMA,
        render: (_args, value) => [
          { type: 'text', text: `已更新：${(value as { content: string }).content}` },
        ],
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = sessionOf(exec);
        const parsed = validateMemoryUpdate(args);
        if (!parsed.ok) toolError(parsed.violations);
        requireContext(handlers, sessionId);
        return view(handlers.update(sessionId, parsed.value));
      },
    },
    {
      name: 'memory_list',
      description: '查看当前患者的长期记忆；可按分类过滤。回答前不确定记得什么时先查。',
      parameters: MEMORY_LIST_PARAMETERS,
      output: {
        schema: LIST_RESULT_SCHEMA,
        render: (_args, value) => {
          const items = (value as { items: Array<{ content: string }> }).items;
          return [
            { type: 'text', text: items.length === 0 ? '暂无记忆。' : items.map((item) => `- ${item.content}`).join('\n') },
          ];
        },
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const sessionId = sessionOf(exec);
        const parsed = validateMemoryList(args);
        if (!parsed.ok) toolError(parsed.violations);
        requireContext(handlers, sessionId);
        return { items: handlers.list(sessionId, parsed.value).map(view) };
      },
    },
  ];
}
