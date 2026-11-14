/**
 * 员工发言语义复核的会话适配器。
 *
 * 复用患者 Agent 的会话机制：一条固定的长会话，逐条判断「这句话是不是真违规」。
 * 只读代码、不改档、不推送，判断结果由调用方决定是否告警。
 *
 * 任何环节失败（会话起不来、超时、宿主不支持事件订阅）都抛错，
 * 由 StaffJudge 转成 unknown，调用方按保守策略继续告警。
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionControllerLike } from './sessions.ts';
import { parseStaffVerdict } from '../../src/p1/staff-judge.ts';

const SESSION_ID = 'zhiban-guard-review';
const DEFAULT_TIMEOUT_MS = 20_000;

export interface StaffJudgeContext {
  sessionController: SessionControllerLike;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface StaffJudgeSessionOptions {
  workspaceRoot: string;
  agentPreset?: string;
  log?(line: string): void;
  timeoutMs?: number;
}

/** 从 session/event 里取助手回复正文；不是 assistant/message 时返回 undefined */
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

interface Waiting {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class StaffJudgeSession {
  private readonly ctx: StaffJudgeContext;
  private readonly options: StaffJudgeSessionOptions;
  private ready?: Promise<string>;
  private subscribed = false;
  /** 串行化：同一会话不能并发跑两次判断 */
  private queue: Promise<unknown> = Promise.resolve();
  /** 有复核在跑时直接拒绝新请求：宁可立刻保守告警，也不让告警排队几分钟 */
  private busy = false;
  private waiting?: Waiting;
  /** 本回合最后一条助手文本：中间态可能只是「我看一下」，要等 turn/end 再定 */
  private lastText?: string;

  constructor(ctx: StaffJudgeContext, options: StaffJudgeSessionOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  ask(prompt: string): Promise<string> {
    if (this.busy) return Promise.reject(new Error('JUDGE_BUSY'));
    this.busy = true;
    const release = (): void => {
      this.busy = false;
    };
    const run = this.queue.then(() => this.runOnce(prompt));
    this.queue = run.then(release, release);
    return run;
  }

  private async runOnce(prompt: string): Promise<string> {
    const sessionId = await this.ensureSession();
    this.subscribe();

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return await new Promise<string>((resolve, reject) => {
      this.lastText = undefined;
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error('JUDGE_TIMEOUT'));
      }, timeoutMs);
      const waiting: Waiting = { resolve, reject, timer };
      this.waiting = waiting;

      this.ctx.sessionController
        .prompt(
          {
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: prompt }],
          },
          new AbortController().signal,
        )
        .catch((error: unknown) => {
          // 只在这次提问仍挂着时才算失败：事件可能已经判完并开始了下一条
          if (this.waiting !== waiting) return;
          this.fail(error instanceof Error ? error : new Error('JUDGE_PROMPT_FAILED'));
        });
    });
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.ctx.on?.('session/event', (...args: unknown[]) => {
      const [session, event] = args;
      if (!this.waiting) return;
      if (sessionIdOf(session) !== SESSION_ID) return;

      const type =
        typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
      if (type === 'turn/start') {
        this.lastText = undefined;
        return;
      }

      const text = extractAssistantText(event);
      if (text !== undefined) {
        this.lastText = text;
        // 能解析出结论就先返回；中间态（「我看一下」）继续等 turn/end
        if (parseStaffVerdict(text) !== 'unknown') this.settle(text);
        return;
      }

      if (type === 'turn/end') {
        if (this.lastText !== undefined) this.settle(this.lastText);
        else this.fail(new Error('JUDGE_EMPTY'));
      }
    });
  }

  private settle(text: string): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.resolve(text);
  }

  private fail(error: Error): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }

  private ensureSession(): Promise<string> {
    if (!this.ready) {
      this.ready = this.createSession().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }

  private async createSession(): Promise<string> {
    const cwd = join(this.options.workspaceRoot, 'guard-review');
    await mkdir(cwd, { recursive: true });

    // 重启后同名会话还在：能解析就直接复用，不重复创建
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(SESSION_ID);
      if (!('error' in resolved)) return SESSION_ID;
    } catch {
      // 会话不存在时按创建处理
    }

    const created = await this.ctx.sessionController.create({
      sessionId: SESSION_ID,
      cwd,
      ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {}),
    });
    this.options.log?.(`语义复核会话已创建：${created.sessionId}`);
    return created.sessionId;
  }
}
