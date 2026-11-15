/**
 * 顾问 1:1「我的待办」命令与 `advisor_overview` 工具共用的格式化（#167 §7.1）。
 *
 * 命令路径与工具路径必须输出同一个文本：验收里「今天有什么要我处理的」的数字
 * 与跑一次「我的待办」命令完全一致。待办只放计数与等待时长，不带草稿正文。
 *
 * `splitForWecom` 从旧话术查询模块迁入（不再复制一份切分算法）。
 */
import { humanWait } from '../../c2/message.ts';
import { shanghaiDayStart } from '../../c2/promises.ts';
import type {
  AdvisorAlertView,
  AdvisorDraftView,
  AdvisorPromiseView,
  TodoSnapshot,
} from './types.ts';

export const DAY_MS = 24 * 60 * 60_000;
export const DRAFT_LIMIT = 5;

export const RISK_LABELS: Record<AdvisorDraftView['riskLevel'], string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

/** 仍在顾问手里的草稿；已确认、忽略、已验证、已释放都不算待办 */
export const DRAFT_STATUS_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  PUSHED: '待确认',
  FAILED: '推送失败',
  UNVERIFIED: '待核验',
  MISROUTE_ALERT: '疑似发错群',
};

export const OPEN_DRAFT_STATUSES = new Set(Object.keys(DRAFT_STATUS_LABELS));

export function openDrafts(drafts: AdvisorDraftView[]): AdvisorDraftView[] {
  return drafts.filter((draft) => OPEN_DRAFT_STATUSES.has(draft.status));
}

/** 构建命令与工具共用的待办快照 */
export function buildTodoSnapshot(input: {
  drafts: AdvisorDraftView[];
  promises: AdvisorPromiseView[];
  alerts: AdvisorAlertView[];
  pendingReplies?: number;
  now: number;
}): TodoSnapshot {
  return {
    drafts: openDrafts(input.drafts),
    promises: input.promises,
    alerts: input.alerts,
    pendingReplies: input.pendingReplies,
    now: input.now,
  };
}

/**
 * 「我的待办」的唯一输出。命令路径与 `advisor_overview` 工具 render 共用，
 * 避免两边数字或措辞不一致（#167 §9 硬规则 3）。
 */
export function formatTodoText(snapshot: TodoSnapshot): string {
  const now = snapshot.now;
  const dayStart = shanghaiDayStart(now);
  const dayEnd = dayStart + DAY_MS;
  const duePromises = snapshot.promises.filter((promise) => promise.dueAt < dayEnd);
  const pendingReplies = snapshot.pendingReplies;
  const total =
    snapshot.drafts.length + duePromises.length + snapshot.alerts.length +
    (pendingReplies ?? 0);
  if (total === 0) {
    return '现在没有待办：没有未完成草稿、今天没有到期承诺、也没有未处理告警。';
  }

  const facts: string[] = [];
  if (snapshot.drafts.length > 0) {
    const oldest = Math.min(...snapshot.drafts.map((draft) => draft.since));
    facts.push(
      `待处理草稿 ${snapshot.drafts.length} 条（最久 ${humanWait(Math.max(0, now - oldest))}）`,
    );
  }
  if (duePromises.length > 0) {
    const next = [...duePromises].sort((a, b) => a.dueAt - b.dueAt)[0]!;
    facts.push(`今日到期承诺 ${duePromises.length} 条（最近 ${next.dueLabel}）`);
  }
  if (snapshot.alerts.length > 0) {
    const latest = [...snapshot.alerts].sort((a, b) => b.at - a.at)[0]!;
    facts.push(`未处理告警 ${snapshot.alerts.length} 条（最近：${latest.title}）`);
  }
  if (pendingReplies !== undefined && pendingReplies > 0) {
    facts.push(`待回复会话 ${pendingReplies} 个`);
  }

  return (
    `今天待办：\n· ${facts.join('\n· ')}\n\n` +
    '草稿正文在企微侧边栏查看；告警详情在控制台「质检与告警」。'
  );
}

/** 待办快照的紧凑一行版，用于每轮前置上下文（#167 §6），只放计数与活动草稿 */
export function formatSnapshotLine(snapshot: TodoSnapshot): string {
  const parts: string[] = [];
  if (snapshot.drafts.length > 0) {
    const oldest = Math.min(...snapshot.drafts.map((draft) => draft.since));
    parts.push(
      `未完成草稿 ${snapshot.drafts.length}（最久 ${humanWait(Math.max(0, snapshot.now - oldest))}）`,
    );
  }
  const dayEnd = shanghaiDayStart(snapshot.now) + DAY_MS;
  const duePromises = snapshot.promises.filter((promise) => promise.dueAt < dayEnd);
  if (duePromises.length > 0) parts.push(`今日到期承诺 ${duePromises.length}`);
  if (snapshot.alerts.length > 0) parts.push(`未处理告警 ${snapshot.alerts.length}`);
  if (snapshot.pendingReplies !== undefined && snapshot.pendingReplies > 0) {
    parts.push(`待回复会话 ${snapshot.pendingReplies}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '现在没有待办';
}

/** 活动草稿元数据的一行描述；只放元数据，不放客户正文 */
export function formatActiveDraftMeta(draft: {
  groupName: string;
  riskLevel: AdvisorDraftView['riskLevel'];
  status: string;
  version?: number;
}): string | undefined {
  if (!draft.groupName) return undefined;
  const version = draft.version && draft.version > 1 ? `第 ${draft.version} 版 · ` : '';
  const status = DRAFT_STATUS_LABELS[draft.status] ?? draft.status;
  return `活动草稿 · ${draft.groupName} · ${version}${status} · ${RISK_LABELS[draft.riskLevel]}`;
}

// ---------- 企微发送切分（从 script-query.ts 迁入） ----------

/** 企微 markdown 单条有字节上限，长回复拆成多条发送 */
export const WECOM_TEXT_MAX_BYTES = 2000;

/**
 * 按 UTF-8 字节切分长文本，优先在换行处断开。
 * `splitForWecom(text).join('') === text`，不丢字符。
 */
export function splitForWecom(text: string, maxBytes = WECOM_TEXT_MAX_BYTES): string[] {
  if (text === '') return [];
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes && current !== '') {
      const breakAt = current.lastIndexOf('\n');
      const cut = breakAt > 0 ? breakAt + 1 : current.length;
      chunks.push(current.slice(0, cut));
      current = current.slice(cut);
      bytes = Buffer.byteLength(current, 'utf8');
    }
    current += char;
    bytes += size;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}
