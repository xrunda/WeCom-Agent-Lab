/**
 * PH5-04（#233）方案生成的 DSH 会话适配。
 *
 * 与仓库既有做法一致：模型不能直接「说话出稿」，必须调用插件注册的工具，
 * 插件在工具回调里拿到结构化参数（见 docs/P1-M0-dsh-validation.md §1.2）。
 *
 * 会话是**独立的生成会话**（`zhiban-plan-<patientId>`），不复用患者与顾问的
 * 对话上下文——否则生成提示词会污染日常服务会话。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanChatPort, PlanChatResult } from '../../src/p1/patient-h5-plan-ai.ts';

interface DshAgentLike {
  whenIdle(): Promise<void>;
}

export interface PlanSessionControllerLike {
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

export interface ToolRegistrarLike {
  register(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: unknown, exec: { agent?: { id?: string } }) => Promise<unknown>;
  }): unknown;
}

export interface PendingDraft {
  resolve(result: PlanChatResult): void;
}

/** 生成会话的工作区说明：约束模型只产出食养安排 */
const AGENTS_MD = `# 食养方案生成

本会话只用于为患者起草食养方案。
- 只安排饮食与日常起居，不诊断、不开药、不给剂量、不承诺疗效。
- 必须调用 submit_health_plan 工具提交结构化方案，不要用普通文本作答。
`;

export interface DshPlanSessionPortOptions {
  sessionController: PlanSessionControllerLike;
  workspaceRoot: string;
  agentPreset?: string;
  log?: (line: string) => void;
}

export class DshPlanSessionPort implements PlanChatPort {
  readonly available = true;
  private readonly pending = new Map<string, PendingDraft>();
  private readonly options: DshPlanSessionPortOptions;

  constructor(options: DshPlanSessionPortOptions) {
    this.options = options;
  }

  /** 工具回调入口：把模型提交的参数交给正在等待的那一轮 */
  acceptToolCall(sessionId: string | undefined, args: unknown): boolean {
    if (!sessionId) return false;
    const waiter = this.pending.get(sessionId);
    if (!waiter) return false;
    waiter.resolve({ toolArgs: args });
    return true;
  }

  async runTurn(request: {
    patientId: string;
    systemPrompt: string;
    userPrompt: string;
    timeoutMs: number;
  }): Promise<PlanChatResult> {
    const sessionId = await this.ensureSession(request.patientId);
    const done = new Promise<PlanChatResult>((resolve) => {
      this.pending.set(sessionId, { resolve });
    });

    const controller = new AbortController();
    try {
      await this.options.sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [
            {
              type: 'text',
              text: `${request.systemPrompt}\n\n${request.userPrompt}`,
            },
          ],
        },
        controller.signal,
      );

      const idle = this.options.sessionController
        .resolveAgent(sessionId)
        .then(async (resolved) => {
          if (!('agent' in resolved)) return;
          await resolved.agent.whenIdle();
        })
        .catch(() => undefined);

      const timeout = new Promise<PlanChatResult>((resolve) =>
        setTimeout(() => resolve({ error: 'TIMEOUT' }), request.timeoutMs),
      );

      const result = await Promise.race([done, timeout, idle.then(() => this.shortWait(done))]);
      return result;
    } catch (error) {
      this.options.log?.(
        `方案生成回合失败：${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return { error: 'MODEL_ERROR' };
    } finally {
      this.pending.delete(sessionId);
      controller.abort();
    }
  }

  /**
   * 回合结束与工具回调之间可能差一个事件循环；给 2 秒宽限，
   * 仍没有结果才判 NO_DRAFT（不把「没提交工具」当成成功）。
   */
  private shortWait(done: Promise<PlanChatResult>): Promise<PlanChatResult> {
    return Promise.race([
      done,
      new Promise<PlanChatResult>((resolve) => setTimeout(() => resolve({ error: 'NO_DRAFT' }), 2000)),
    ]);
  }

  private async ensureSession(patientId: string): Promise<string> {
    const requested = `zhiban-plan-${patientId}`;
    const workspacePath = join(this.options.workspaceRoot, `plan-${patientId}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'AGENTS.md'), AGENTS_MD, 'utf8');

    try {
      const resolved = await this.options.sessionController.resolveAgent(requested);
      if (!('error' in resolved)) return requested;
    } catch {
      // 解析失败按新建处理
    }
    const created = await this.options.sessionController.create({
      sessionId: requested,
      cwd: workspacePath,
      ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {}),
    });
    return created.sessionId;
  }
}

/** submit_health_plan 工具定义：参数 schema 即草稿结构 */
export function buildPlanTool(port: DshPlanSessionPort): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: { agent?: { id?: string } }) => Promise<unknown>;
} {
  return {
    name: 'submit_health_plan',
    description:
      '提交一份食养方案草稿供专业审核。只包含饮食与日常起居安排，不包含诊断、用药、剂量或疗效结论。必须调用本工具，不要用普通文本作答。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['stageGoal', 'foodTherapyRationale', 'focusPoints', 'actions'],
      properties: {
        stageGoal: { type: 'string', description: '本阶段目标，患者可读，≤200 字' },
        foodTherapyRationale: { type: 'string', description: '食养思路，≤500 字' },
        focusPoints: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: '本阶段重点短句',
        },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'purpose', 'method', 'schedule', 'feedbackKind'],
            properties: {
              title: { type: 'string', description: '行动名，≤30 字' },
              purpose: { type: 'string', description: '为什么做，≤60 字' },
              method: { type: 'string', description: '怎么做，≤120 字' },
              schedule: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'time'],
                properties: {
                  kind: { type: 'string', enum: ['daily', 'weekly', 'oneoff'] },
                  time: { type: 'string', description: 'HH:mm' },
                },
              },
              feedbackKind: {
                type: 'string',
                enum: ['checkin', 'record_meal', 'record_review', 'none'],
              },
            },
          },
        },
        feedbackRequirements: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 3,
          description: '希望患者反馈什么',
        },
      },
    },
    execute: async (args, exec) => {
      const accepted = port.acceptToolCall(exec.agent?.id, args);
      return {
        accepted,
        message: accepted ? '方案已提交，等待专业审核。' : '当前没有等待中的方案生成请求。',
      };
    },
  };
}
