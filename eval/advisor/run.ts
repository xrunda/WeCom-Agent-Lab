/**
 * 顾问 Agent 离线评测执行器（#167 §13）。
 *
 * 离线模式：用假 DSH 上下文装配真实插件，按案例驱动真实工具，校验
 * 数据整形 / 越权 / 原文照抄 / 数据缺口不编造。确定性、可回归。
 * 真 DSH + 真模型的回合（模型是否按三分法选对工具、回答是否合规）由
 * 项目负责人在真机执行（⏳），本报告只写「离线通过」。
 *
 * 用法：
 *   npm run eval:advisor
 * 报告写到 eval/advisor/last-report.md。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { apply as applyAdvisor } from '../../plugins/zhiban-advisor/index.ts';
import type { RegisteredTool } from '../../src/p1/reply-tools.ts';
import { emptyChronicProfile } from '../../src/p1/chronic.ts';
import { shanghaiDayStart } from '../../src/c2/promises.ts';
import type { ChronicProfile } from '../../src/p1/chronic.ts';
import { loadCases, EVAL_ROOT } from './load.ts';
import type { AdvisorEvalCase, AdvisorEvalCheck, AdvisorEvalResult } from './types.ts';

const NOW = 1_700_000_000_000;

// ---------- 虚构种子数据 ----------

const SEED = {
  knowledge: [{ id: 'kn_1', category: '饮食', title: '高血压饮食', content: '低盐低脂，控制主食总量。', enabled: true }],
  scripts: [{ id: 'sc_1', category: '复诊', title: '复诊提醒话术', content: '您好，请按医嘱复诊。', tags: [] }],
  rules: [{ id: 'r_1', kind: 'redline', name: '不承诺疗效', keywords: ['保证', '疗效'], riskLevel: 'high' as const, action: '提示' }],
  patients: [
    { id: 'p1', displayName: '汪女士', externalUserId: 'wm_001', advisorId: 'adv_1', tags: ['高血压'], consent: 'agreed' as const, status: 'serving' as const },
    { id: 'p2', displayName: '别的顾问的患者', externalUserId: 'wm_002', advisorId: 'adv_2', tags: [], consent: 'agreed' as const, status: 'serving' as const },
    { id: 'p3', displayName: '李阿姨', externalUserId: 'wm_003', advisorId: 'adv_1', tags: [], consent: 'agreed' as const, status: 'serving' as const },
  ],
  chronic: {
    p1: {
      patientId: 'p1',
      tenantId: 'tn_eval',
      conditions: ['高血压'],
      medications: [{ name: '氨氯地平', dose: '5mg', source: 'advisor' as const, updatedAt: NOW - 3_600_000 }],
      measurements: [
        {
          id: 'm1',
          metric: 'glucose' as const,
          value: 5.8,
          measuredAt: NOW - 86_400_000,
          source: 'advisor' as const,
          recordedAt: NOW - 86_400_000,
        },
      ],
      updatedAt: NOW - 3_600_000,
    } satisfies ChronicProfile,
  },
};

function fakeContext() {
  const tools: RegisteredTool[] = [];
  const provided = new Map<string, unknown>();
  const effects: Array<Promise<void>> = [];

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(fn: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>) {
      const promise = Promise.resolve(fn()).then(() => {});
      effects.push(promise);
      return promise;
    },
    emit: () => {},
    provide: (name: string, value: unknown) => void provided.set(name, value),
    get: <T = unknown>(name: string): T | undefined => provided.get(name) as T | undefined,
    storageDomain: {
      async open() {
        return {
          table: () => ({
            entries: () => new Map(),
            put: async () => {},
          }),
          close: async () => {},
        };
      },
    },
    tools: { register: (definition: unknown) => void tools.push(definition as RegisteredTool) },
    on: () => {},
    sessionController: {
      create: async (request: { sessionId: string }) => ({ sessionId: request.sessionId }),
      resolveAgent: async () => ({ agent: { whenIdle: async () => {}, inject: () => {} } }),
      prompt: async () => {},
    },
  } as never;

  applyAdvisor(ctx, {
    workspaceRoot: '/tmp/zhiban-eval-advisors',
    agentPreset: 'zhiban-advisor',
    turnTimeoutMs: 30_000,
    maxConcurrentTurns: 2,
    messagesPerMinute: 20,
    messagesPerDay: 500,
    enabled: true,
  });

  const seedPorts = (): void => {
    // 待办里的等待时长与承诺到期都相对真实时钟，报告里的数值才像话
    const realNow = Date.now();
    provided.set('zhibanAdvisorData', {
      advisorName: () => '王顾问',
      draftsFor: (advisorId: string) =>
        advisorId === 'adv_1'
          ? [{ id: 'd1', groupName: '群 1', riskLevel: 'medium', status: 'PUSHED', since: realNow - 2 * 3_600_000 }]
          : [],
      promisesFor: (advisorId: string) =>
        advisorId === 'adv_1'
          // 承诺到期取「今日零点后 1 小时」，保证任何时刻都落在今天，评测不随时间抖动
          ? [{ groupName: '群 1', dueAt: shanghaiDayStart(Date.now()) + 3_600_000, dueLabel: '今天 18:00' }]
          : [],
      alertsFor: (advisorId: string) =>
        advisorId === 'adv_1'
          ? [{ id: 'a1', title: '员工发言命中红线', at: realNow - 5 * 60_000, ruleIds: ['r_1'] }]
          : [],
      pendingRepliesFor: () => 2,
      activeDraftFor: () => undefined,
      sendText: async () => true,
      canReadPatient: true,
    });
    provided.set('zhibanKnowledge', {
      list: () => SEED.knowledge,
    });
    provided.set('zhibanScripts', {
      listEnabled: () => SEED.scripts,
    });
    provided.set('zhibanGuard', {
      getRule: (id: string) => SEED.rules.find((rule) => rule.id === id),
    });
    provided.set('zhibanPatient', {
      listPatients: () => [...SEED.patients],
      getPatientAdmin: (id: string) => SEED.patients.find((patient) => patient.id === id),
      getPatientBindings: () => [],
      listGroups: () => [],
      listAdvisors: () => [
        { id: 'adv_1', wecomUserId: 'wang.guwen' },
        { id: 'adv_2', wecomUserId: 'li.si' },
      ],
      getChronicProfile: (patientId: string) =>
        SEED.chronic[patientId as keyof typeof SEED.chronic]
          ? (SEED.chronic[patientId as keyof typeof SEED.chronic] as ChronicProfile)
          : emptyChronicProfile(patientId, 'tn_eval'),
    });
  };

  return { tools, seedPorts, ready: Promise.all(effects).then(() => undefined) };
}

// ---------- 判定 ----------

function checkCase(
  case_: AdvisorEvalCase,
  value: unknown,
  rendered: string,
): AdvisorEvalCheck[] {
  const checks: AdvisorEvalCheck[] = [];
  const record = value as Record<string, unknown>;
  const check = (id: string, label: string, pass: boolean, detail?: string): void => {
    checks.push({ id, label, pass, detail });
  };

  // overview 返回 { snapshot } 不带 status；有快照即视为成功
  const statusOk =
    case_.expectTool === 'advisor_overview'
      ? (record as { snapshot?: unknown }).snapshot !== undefined
      : record.status === case_.expectStatus;
  check('status', '工具状态符合预期', statusOk, `期望 ${case_.expectStatus}`);
  for (const text of case_.requireText) {
    check('require', `必须出现「${text}」`, rendered.includes(text));
  }
  for (const text of case_.forbidText) {
    check('forbid', `禁止出现「${text}」`, !rendered.includes(text));
  }

  // 原文一致性：命中条目的内容与种子原文逐字相等
  if (case_.verbatimId) {
    const items = Array.isArray(record.items)
      ? (record.items as Array<{ id: string; content?: string }>)
      : record.item
        ? [record.item as { id: string; content?: string }]
        : [];
    const hit = items.find((item) => item.id === case_.verbatimId);
    const expected = [
      ...SEED.knowledge,
      ...SEED.scripts,
      ...SEED.rules,
    ].find((item) => item.id === case_.verbatimId);
    const verbatim =
      hit !== undefined && expected !== undefined && hit.content === expected.content;
    check(
      'verbatim',
      `原文照抄：${case_.verbatimId} 返回与库内原文逐字相等`,
      verbatim,
      `got=${JSON.stringify(hit?.content)} expected=${JSON.stringify(expected?.content)}`,
    );
  }
  return checks;
}

async function run(): Promise<void> {
  const cases = loadCases();
  const harness = fakeContext();
  await harness.ready;

  const results: AdvisorEvalResult[] = [];
  for (const case_ of cases) {
    harness.seedPorts();
    const tool = harness.tools.find((item) => item.name === case_.expectTool);
    if (!tool) throw new Error(`找不到工具 ${case_.expectTool}`);
    const value = await tool.execute(case_.expectArgs, { agent: { id: 'zhiban-advisor-adv_1' } });
    const rendered = tool.output
      .render(case_.expectArgs, value)
      .map((block) => block.text)
      .join('\n');
    const checks = checkCase(case_, value, rendered);
    results.push({
      id: case_.id,
      message: case_.message,
      expectTool: case_.expectTool,
      pass: checks.every((check) => check.pass),
      checks,
      renderedText: rendered,
    });
  }

  const passed = results.filter((result) => result.pass).length;
  const lines: string[] = [];
  lines.push('# 顾问 Agent 评测报告（离线）');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()} · 通过 ${passed}/${results.length}`);
  lines.push('> 本报告只覆盖离线确定性校验（工具结果 / 越权 / 原文照抄 / 数据缺口）。');
  lines.push('> 真 DSH + 真模型的回合与最终回答合规性由项目负责人真机执行（⏳），不算「已通过」。');
  lines.push('');
  for (const result of results) {
    lines.push(`## ${result.id} · ${result.pass ? '✅ 通过' : '❌ 未通过'} · ${result.expectTool}`);
    lines.push('');
    lines.push(`问题：${result.message}`);
    lines.push('');
    for (const check of result.checks) {
      lines.push(`- ${check.pass ? '✅' : '❌'} ${check.label}${check.detail ? ` —— ${check.detail}` : ''}`);
    }
    if (!result.pass) {
      lines.push('');
      lines.push('工具输出：');
      lines.push('```');
      lines.push(result.renderedText);
      lines.push('```');
    }
    lines.push('');
  }
  writeFileSync(resolve(EVAL_ROOT, 'last-report.md'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  if (passed !== results.length) process.exitCode = 1;
}

run().catch((error: unknown) => {
  console.error(`评测执行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
