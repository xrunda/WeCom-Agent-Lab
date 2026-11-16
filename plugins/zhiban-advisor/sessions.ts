/**
 * zhiban-advisor 的 DSH 会话适配器（#167 §4 / §5）。
 *
 * 每个顾问一条长期会话 `zhiban-advisor-<advisorId>`，工作区
 * `<workspaceRoot>/<advisorId>`。回复从 `session/event` 事件里捕获：
 * 取一轮里最后一条纯文本 `assistant/message` 作为最终回复（中间态不算），
 * `turn/end` 决定回合结果；超时后仍完成的回合通过 onLateComplete 补发。
 *
 * 事件按 sessionId + turn 号匹配，避免「上一轮超时后完成」与「新一轮开始」
 * 交错时把旧回合的事件算进新回合。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ADVISOR_SESSION_PREFIX } from '../../src/p1/advisor/tools.ts';
import type { AdvisorSessionRecord } from '../../src/p1/advisor/types.ts';
import { buildAdvisorAgentsMd } from '../../src/p1/advisor/persona.ts';
import type { AdvisorSessionStore } from './domain.ts';

export interface DshAgentLike {
  whenIdle(): Promise<void>;
  inject(message: unknown): void;
}

export interface SessionControllerLike {
  create(request: {
    sessionId?: string;
    cwd: string;
    agentPreset?: string;
  }): Promise<{ sessionId: string }>;
  resolveAgent(sessionId: string): Promise<{ agent: DshAgentLike } | { error: unknown }>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: 'queue';
      content: Array<{ type: 'text'; text: string }>;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface AdvisorSessionContext {
  sessionController: SessionControllerLike;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface AdvisorSessionPort {
  ensure(advisorId: string): Promise<AdvisorSessionRecord>;
  reset(advisorId: string): Promise<AdvisorSessionRecord>;
  runTurn(input: {
    sessionId: string;
    prompt: string;
    timeoutMs: number;
    onLateComplete?: (text: string) => void;
  }): Promise<AdvisorTurnOutcome>;
}

export interface AdvisorTurnOutcome {
  /** completed=正常完成；interrupted=中断但有前缀文本；timeout=超时；error=报错；empty=没产出文本 */
  status: 'completed' | 'interrupted' | 'timeout' | 'error' | 'empty';
  text?: string;
}

export interface AdvisorSessionOptions {
  workspaceRoot: string;
  agentPreset?: string;
  store: AdvisorSessionStore;
  logger?: (line: string) => void;
}

/** 从 session/event 里取助手回复正文；与 zhiban-patient 的语义复核同一套解析 */
export function extractAssistantText(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as {
    type?: unknown;
    data?: { message?: { content?: unknown } };
  };
  if (e.type !== 'assistant/message') return undefined;
  const blocks = e.data?.message?.content;
  if (!Array.isArray(blocks)) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  const text = parts.join('').trim();
  return text === '' ? undefined : text;
}

function sessionIdOf(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined;
  const header = (session as { header?: { id?: unknown } }).header;
  return typeof header?.id === 'string' ? header.id : undefined;
}

interface Wait {
  resolve(value: AdvisorTurnOutcome): void;
  reject(error: Error): void;
  /** 启动时间，用于判定超时 */
  timer?: ReturnType<typeof setTimeout>;
  /** 本轮事件匹配用 turn 号；未遇到 turn/start 前为空 */
  turn?: number;
  lastText?: string;
  interrupted?: boolean;
  /** 超时后仍监听；turn/end 到达时回调 */
  late?: boolean;
}

export class AdvisorSessionAdapter implements AdvisorSessionPort {
  private readonly ctx: AdvisorSessionContext;
  private readonly options: AdvisorSessionOptions;
  private readonly pending = new Map<string, Promise<AdvisorSessionRecord>>();
  /** sessionId → 最近一次 turn/start 的 turn 号 */
  private readonly lastTurn = new Map<string, number>();
  /** sessionId → 正在等待的回合（正常或超时后补听） */
  private readonly waits = new Map<string, Wait>();
  private subscribed = false;
  private resets = 0;

  constructor(ctx: AdvisorSessionContext, options: AdvisorSessionOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  async ensure(advisorId: string): Promise<AdvisorSessionRecord> {
    const existing = this.options.store.get(advisorId);
    if (existing) return existing;
    const inflight = this.pending.get(advisorId);
    if (inflight) return inflight;

    const task = this.create(advisorId).finally(() => {
      this.pending.delete(advisorId);
    });
    this.pending.set(advisorId, task);
    return task;
  }

  private async create(advisorId: string): Promise<AdvisorSessionRecord> {
    const requested = `${ADVISOR_SESSION_PREFIX}${advisorId}`;
    const workspacePath = join(this.options.workspaceRoot, advisorId);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'AGENTS.md'), buildAdvisorAgentsMd(), 'utf8');

    // 重启后同名会话还在：能解析就直接复用，不重复创建
    let sessionId = requested;
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(requested);
      if ('error' in resolved) {
        const created = await this.ctx.sessionController.create({
          sessionId: requested,
          cwd: workspacePath,
          ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {}),
        });
        sessionId = created.sessionId;
      }
    } catch {
      const created = await this.ctx.sessionController.create({
        sessionId: requested,
        cwd: workspacePath,
        ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {}),
      });
      sessionId = created.sessionId;
    }

    const record: AdvisorSessionRecord = {
      advisorId,
      sessionId,
      workspacePath,
      createdAt: Date.now(),
    };
    this.options.store.save(record);
    this.options.logger?.(`顾问 ${advisorId} 会话就绪 session=${sessionId}`);
    return record;
  }

  /** 清空上下文：新建一条全新会话并覆盖记录；旧会话不再复用 */
  async reset(advisorId: string): Promise<AdvisorSessionRecord> {
    const suffix = `${Date.now()}_${++this.resets}`;
    const sessionId = `${ADVISOR_SESSION_PREFIX}${advisorId}-r${suffix}`;
    const workspacePath = join(this.options.workspaceRoot, `${advisorId}-r${suffix}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'AGENTS.md'), buildAdvisorAgentsMd(), 'utf8');
    const created = await this.ctx.sessionController.create({
      sessionId,
      cwd: workspacePath,
      ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {}),
    });
    const record: AdvisorSessionRecord = {
      advisorId,
      sessionId: created.sessionId,
      workspacePath,
      createdAt: Date.now(),
    };
    this.options.store.save(record);
    this.options.logger?.(`顾问 ${advisorId} 会话已重置`);
    return record;
  }

  async runTurn(input: {
    sessionId: string;
    prompt: string;
    timeoutMs: number;
    onLateComplete?: (text: string) => void;
  }): Promise<AdvisorTurnOutcome> {
    this.subscribe();
    return await new Promise<AdvisorTurnOutcome>((resolve, reject) => {
      const wait: Wait = { resolve, reject, lastText: undefined };
      this.waits.set(input.sessionId, wait);

      const timer = setTimeout(() => {
        // 超时：先回「还在处理」，后台继续听 turn/end，完成后补发
        if (this.waits.get(input.sessionId) !== wait) return;
        wait.timer = undefined;
        this.waits.delete(input.sessionId);
        wait.resolve({ status: 'timeout', text: wait.lastText });
        const lateWaiter: Wait = {
          resolve: (outcome) => {
            if (outcome.text && input.onLateComplete) input.onLateComplete(outcome.text);
          },
          reject: wait.reject,
          turn: wait.turn ?? this.lastTurn.get(input.sessionId),
          lastText: wait.lastText,
          interrupted: wait.interrupted,
          late: true,
        };
        this.waits.set(input.sessionId, lateWaiter);
      }, input.timeoutMs);
      wait.timer = timer;
      timer.unref?.();

      this.ctx.sessionController
        .prompt(
          {
            requestId: randomUUID(),
            sessionId: input.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: input.prompt }],
          },
          new AbortController().signal,
        )
        .catch((error: unknown) => {
          // 只在这次提问仍挂着时才算失败
          if (this.waits.get(input.sessionId) !== wait) return;
          clearTimeout(timer);
          this.waits.delete(input.sessionId);
          wait.reject(error instanceof Error ? error : new Error('ADVISOR_PROMPT_FAILED'));
        });
    });
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.ctx.on?.('session/event', (session: unknown, event: unknown) => {
      const sessionId = sessionIdOf(session);
      if (!sessionId) return;
      const wait = this.waits.get(sessionId);
      if (!wait) return;

      const type =
        typeof event === 'object' && event !== null
          ? (event as { type?: unknown }).type
          : undefined;
      const data =
        typeof event === 'object' && event !== null
          ? (event as { data?: { turn?: number; reason?: { kind?: string }; interrupted?: boolean } }).data
          : undefined;

      if (type === 'turn/start') {
        this.lastTurn.set(sessionId, data?.turn ?? 0);
        if (wait.turn === undefined && !wait.late) wait.turn = data?.turn;
        wait.lastText = undefined;
        return;
      }
      if (type === 'assistant/message') {
        if (wait.turn !== undefined && data?.turn !== undefined && data.turn !== wait.turn) return;
        const text = extractAssistantText(event);
        if (text !== undefined) wait.lastText = text;
        if (data?.interrupted === true) wait.interrupted = true;
        return;
      }
      if (type === 'turn/end') {
        if (wait.turn !== undefined && data?.turn !== undefined && data.turn !== wait.turn) return;
        const kind = data?.reason?.kind;
        this.waits.delete(sessionId);
        if (wait.timer) clearTimeout(wait.timer);
        if (kind === 'completed') {
          if (wait.lastText !== undefined) {
            wait.resolve({ status: 'completed', text: wait.lastText });
          } else {
            wait.resolve({ status: 'empty' });
          }
          return;
        }
        if (wait.lastText !== undefined) {
          wait.resolve({ status: wait.interrupted ? 'interrupted' : 'error', text: wait.lastText });
          return;
        }
        wait.resolve({ status: 'empty' });
      }
    });
  }
}
