/**
 * zhiban-patient 的 DSH 会话适配器（#34）。
 *
 * 每个患者一个长期 Session：记忆、知识与工作区都跟着 Session 走。
 * 这里只声明用到的 DSH 结构类型，避免把仓库绑死在 dsh 的包版本上。
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PatientSessionPort } from '../../src/p1/session-port.ts';
import type { Patient, PatientSessionRecord } from '../../src/p1/types.ts';

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

export interface DshSessionContext {
  sessionController: SessionControllerLike;
}

export interface DshPatientSessionsOptions {
  workspaceRoot: string;
  agentPreset?: string;
  findSession(patientId: string): PatientSessionRecord | undefined;
  saveSession(record: PatientSessionRecord): void;
  logger?: (line: string) => void;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** 等价于 dsh-llm 的 createUserMessage：注入上下文但不唤醒回合 */
export function makeUserMessage(text: string): unknown {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

export class DshPatientSessions implements PatientSessionPort {
  private readonly ctx: DshSessionContext;
  private readonly options: DshPatientSessionsOptions;
  private readonly pending = new Map<string, Promise<PatientSessionRecord>>();
  private resets = 0;

  constructor(ctx: DshSessionContext, options: DshPatientSessionsOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  async ensure(patient: Patient): Promise<PatientSessionRecord> {
    const existing = this.options.findSession(patient.id);
    if (existing) return existing;
    const inflight = this.pending.get(patient.id);
    if (inflight) return inflight;

    const task = this.create(patient).finally(() => {
      this.pending.delete(patient.id);
    });
    this.pending.set(patient.id, task);
    return task;
  }

  private async create(patient: Patient): Promise<PatientSessionRecord> {
    const workspacePath = join(this.options.workspaceRoot, patient.id);
    await mkdir(workspacePath, { recursive: true });
    const created = await this.ctx.sessionController.create({
      sessionId: `zhiban-patient-${patient.id}`,
      cwd: workspacePath,
      agentPreset: this.options.agentPreset,
    });
    const record: PatientSessionRecord = {
      patientId: patient.id,
      sessionId: created.sessionId,
      workspacePath,
      createdAt: Date.now(),
    };
    this.options.saveSession(record);
    this.options.logger?.(`患者 ${patient.id} 会话就绪`);
    return record;
  }

  /** #40：新建一条全新会话并覆盖该患者的会话记录；旧会话不再被复用 */
  async reset(patient: Patient): Promise<PatientSessionRecord> {
    const suffix = `${Date.now()}_${++this.resets}`;
    const workspacePath = join(this.options.workspaceRoot, `${patient.id}-r${suffix}`);
    await mkdir(workspacePath, { recursive: true });
    const created = await this.ctx.sessionController.create({
      sessionId: `zhiban-patient-${patient.id}-r${suffix}`,
      cwd: workspacePath,
      agentPreset: this.options.agentPreset,
    });
    const record: PatientSessionRecord = {
      patientId: patient.id,
      sessionId: created.sessionId,
      workspacePath,
      createdAt: Date.now(),
    };
    this.options.saveSession(record);
    this.options.logger?.(`患者 ${patient.id} 沙盒会话已重置`);
    return record;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.agent(sessionId);
    await this.ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    );
  }

  async injectContext(sessionId: string, text: string): Promise<void> {
    const agent = await this.agent(sessionId);
    agent.inject(makeUserMessage(text));
  }

  async waitIdle(sessionId: string, timeoutMs: number): Promise<'idle' | 'timeout'> {
    const agent = await this.agent(sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([agent.whenIdle().then(() => 'idle' as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async agent(sessionId: string): Promise<DshAgentLike> {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('agent' in resolved) return resolved.agent;
    throw new Error(`AGENT_UNAVAILABLE ${sessionId}`);
  }
}
