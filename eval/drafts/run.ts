/**
 * #64 草稿质量评测执行器。
 *
 * 用法（需要真 DSH + 真插件 + 控制台）：
 *   ZHIBAN_EVAL_BASE_URL=http://127.0.0.1:8788 \
 *   ZHIBAN_EVAL_USERNAME=... ZHIBAN_EVAL_PASSWORD=... \
 *   npm run eval:drafts
 *
 * 评测集与图片均为虚构；报告默认写到 eval/drafts/last-report.md，
 * 用 `--out docs/P1-eval-report.md` 覆盖正式报告。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkDraft } from './checks.ts';
import { ensureFixtures, fixturesAreSynthetic } from './fixtures.ts';
import { judgeConfigFromEnv, judgeDraft, type JudgeConfig } from './judge.ts';
import { EVAL_ROOT, assertDatasetSize, loadCases, splitCases } from './load.ts';
import { formatDate, renderReport, writeReport, type ReportMeta } from './report.ts';
import { SandboxClient, SandboxHttpError, sleep } from './sandbox-client.ts';
import type { CaseResult, EvalCase } from './types.ts';

interface Options {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  setupTimeoutMs: number;
  pollMs: number;
  pauseMs: number;
  out: string;
  judge: JudgeConfig | undefined;
  keepSession: boolean;
  regenFixtures: boolean;
  scope: 'all' | 'text' | 'images';
  ids: string[];
  limit?: number;
}

function readOption(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
    return argv[index + 1];
  }
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function parseOptions(argv: string[]): Options {
  const baseUrl = readOption(argv, 'base-url') ?? process.env.ZHIBAN_EVAL_BASE_URL ?? '';
  const username = readOption(argv, 'username') ?? process.env.ZHIBAN_EVAL_USERNAME ?? '';
  const password = readOption(argv, 'password') ?? process.env.ZHIBAN_EVAL_PASSWORD ?? '';
  const timeoutRaw = Number(readOption(argv, 'timeout-ms') ?? 180_000);
  const setupTimeoutRaw = Number(readOption(argv, 'setup-timeout-ms') ?? 60_000);
  const pollRaw = Number(readOption(argv, 'poll-ms') ?? 1_000);
  const pauseRaw = Number(readOption(argv, 'pause-ms') ?? 0);
  const limitRaw = Number(readOption(argv, 'limit') ?? '');
  const scopeRaw = readOption(argv, 'scope') ?? 'all';
  if (scopeRaw !== 'all' && scopeRaw !== 'text' && scopeRaw !== 'images') {
    throw new Error('--scope 只能是 all / text / images');
  }
  return {
    baseUrl,
    username,
    password,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 180_000,
    setupTimeoutMs:
      Number.isFinite(setupTimeoutRaw) && setupTimeoutRaw > 0 ? setupTimeoutRaw : 60_000,
    pollMs: Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 1_000,
    pauseMs: Number.isFinite(pauseRaw) && pauseRaw >= 0 ? pauseRaw : 0,
    out: resolve(readOption(argv, 'out') ?? resolve(EVAL_ROOT, 'last-report.md')),
    judge: hasFlag(argv, 'no-judge') ? undefined : judgeConfigFromEnv(),
    keepSession: hasFlag(argv, 'keep-session'),
    regenFixtures: hasFlag(argv, 'regen-fixtures'),
    scope: scopeRaw,
    ids: argv.filter((item) => item.startsWith('--id=')).map((item) => item.slice('--id='.length)),
    ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
  };
}

function selectCases(options: Options): EvalCase[] {
  const all = loadCases();
  assertDatasetSize(all);
  let selected = all;
  if (options.scope === 'text') selected = splitCases(selected).text;
  if (options.scope === 'images') selected = splitCases(selected).images;
  if (options.ids.length > 0) selected = selected.filter((item) => options.ids.includes(item.id));
  if (options.limit) selected = selected.slice(0, options.limit);
  return selected;
}

function quoteError(error: unknown): string {
  if (error instanceof SandboxHttpError) return `${error.code}：${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runCase(
  client: SandboxClient,
  options: Options,
  testCase: EvalCase,
): Promise<CaseResult> {
  const result: CaseResult = { case: testCase };
  try {
    if (!options.keepSession) await client.reset();

    if (testCase.setupMessage) {
      const beforeSetup = await client.draftIds();
      const setupAt = await client.postText(testCase.setupMessage);
      await client.waitForDraft(beforeSetup, setupAt, options.setupTimeoutMs, options.pollMs);
      const afterSetup = await client.state();
      result.memorySeeded =
        afterSetup.memories.length > 0 ||
        afterSetup.events.some((event) => event.type === 'sandbox.memory');
      if (!options.keepSession) await client.reset();
    }

    const before = await client.draftIds();
    let acceptedAt: number;
    if (testCase.kind === 'image') {
      const imagePath = resolve(EVAL_ROOT, testCase.image);
      if (!existsSync(imagePath) || statSync(imagePath).size === 0) {
        throw new Error(`图片夹具不存在：${testCase.image}`);
      }
      const mediaId = await client.upload(imagePath);
      acceptedAt = await client.postImage(mediaId);
    } else {
      acceptedAt = await client.postText(testCase.message);
    }

    const { draft, latencyMs } = await client.waitForDraft(
      before,
      acceptedAt,
      options.timeoutMs,
      options.pollMs,
    );
    result.draftId = draft.id;
    result.body = draft.body;
    result.riskLevel = draft.riskLevel;
    result.fallback = draft.fallback === true;
    result.mediaKinds = draft.mediaKinds ?? [];
    result.latencyMs = latencyMs;
    result.rule = checkDraft({
      testCase,
      body: draft.body,
      fallback: result.fallback,
      mediaKinds: result.mediaKinds,
    });

    if (options.judge) {
      try {
        result.judge = await judgeDraft(options.judge, testCase, draft.body, result.rule.violations);
      } catch (error) {
        result.judgeError = quoteError(error);
      }
    }
  } catch (error) {
    result.error = quoteError(error);
    if (error instanceof SandboxHttpError && error.code === 'UPSTREAM_UNAVAILABLE') throw error;
  }
  return result;
}

function progressLine(result: CaseResult, judgeConfigured: boolean): string {
  if (result.error) return `✖ ${result.case.id} 错误：${result.error}`;
  const rule = result.rule?.pass ? '规则✓' : '规则✖';
  const judge = judgeConfigured
    ? result.judge
      ? result.judge.pass
        ? '评审✓'
        : '评审✖'
      : '评审—'
    : '';
  const latency = result.latencyMs === undefined ? '—' : `${(result.latencyMs / 1000).toFixed(1)}s`;
  return `${rule}${judge ? ` ${judge}` : ''} ${latency} ${result.case.id}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.baseUrl || !options.username || !options.password) {
    console.error(
      '缺少控制台地址或账号：请设置 ZHIBAN_EVAL_BASE_URL / ZHIBAN_EVAL_USERNAME / ZHIBAN_EVAL_PASSWORD，或用 --base-url / --username / --password。',
    );
    process.exitCode = 2;
    return;
  }

  const cases = selectCases(options);
  if (cases.length === 0) {
    console.error('没有匹配的评测案例。');
    process.exitCode = 2;
    return;
  }

  ensureFixtures(EVAL_ROOT, { force: options.regenFixtures });
  const client = new SandboxClient({
    baseUrl: options.baseUrl,
    username: options.username,
    password: options.password,
  });

  await client.login();
  await client.ensureSession();
  const quota = await client.quota();
  const setupCount = cases.filter((item) => item.setupMessage).length;
  const needed = cases.length + setupCount;
  if (quota.remaining < needed) {
    console.error(
      `沙盒当日剩余额度 ${quota.remaining} 条，本次至少需要 ${needed} 条（含记忆前置 ${setupCount} 条）。请隔天再跑，或减少 --limit / --scope。`,
    );
    process.exitCode = 2;
    return;
  }

  if (!options.judge) {
    console.log('未配置 EVAL_JUDGE_*，本次只做规则检查；报告会标注「未启用模型评审」。');
  }
  console.log(`开始评测 ${cases.length} 条，单条上限 ${Math.round(options.timeoutMs / 1000)} 秒。`);

  const results: CaseResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    const result = await runCase(client, options, testCase);
    results.push(result);
    console.log(`[${index + 1}/${cases.length}] ${progressLine(result, Boolean(options.judge))}`);
    if (options.pauseMs > 0) await sleep(options.pauseMs);
  }

  const host = safeHost(options.baseUrl);
  const meta: ReportMeta = {
    generatedAt: Date.now(),
    baseUrlHost: host,
    ...(options.judge ? { judgeModel: options.judge.model } : {}),
    judgeConfigured: Boolean(options.judge),
    timeoutMs: options.timeoutMs,
    imageFixturesSynthetic: fixturesAreSynthetic(EVAL_ROOT),
    ...(options.judge?.inputPricePerMTok !== undefined
      ? { inputPricePerMTok: options.judge.inputPricePerMTok }
      : {}),
    ...(options.judge?.outputPricePerMTok !== undefined
      ? { outputPricePerMTok: options.judge.outputPricePerMTok }
      : {}),
  };
  const report = renderReport(results, meta);
  writeReport(options.out, report);

  const total = results.length;
  const rulePassed = results.filter((item) => item.rule?.pass).length;
  const overall = results.filter((item) => {
    if (!item.rule?.pass) return false;
    if (!options.judge) return true;
    return item.judge?.pass === true && (item.judge.score ?? 0) >= 7;
  }).length;
  const redlineClear = results.filter((item) =>
    (item.rule?.checks ?? [])
      .filter((check) => check.id.startsWith('redline-'))
      .every((check) => check.pass),
  ).length;
  console.log('');
  console.log(`规则通过 ${rulePassed}/${total}，整体通过 ${overall}/${total}，红线全清 ${redlineClear}/${total}。`);
  console.log(`报告已写入 ${options.out}（${formatDate(meta.generatedAt)}）。`);

  const passRate = total > 0 ? overall / total : 0;
  if (passRate < 0.9 || redlineClear !== total) process.exitCode = 1;
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '未知地址';
  }
}

main().catch((error) => {
  console.error(`评测失败：${quoteError(error)}`);
  process.exitCode = 1;
});
