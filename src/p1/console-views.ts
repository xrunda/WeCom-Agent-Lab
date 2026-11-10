/**
 * 控制台真实数据视图（docs/P1-api.md §4–§8）。
 *
 * 患者域 / 企微域只提供领域记录，控制台在这里把记录翻成前端契约。
 * 纯函数、无 I/O：沙盒数据不计入工作台，所有统计都只基于传入的真实记录。
 */
import type { Draft } from '../c2/types.ts';
import { dayKey } from './console-types.ts';
import type { CarePlanRecord } from './care.ts';
import type { MemoryRecord } from './memory.ts';
import type { AdvisorRecord, GroupBinding, Patient } from './types.ts';

// ---------- 与前端一致的响应形状 ----------

export type DashboardRange = 'today' | 'week' | 'month';

export interface DashboardTrendPointView {
  date: string;
  label: string;
  volume: number;
  verified: number;
}

export interface DashboardAdvisorRankView {
  advisorId: string;
  name: string;
  status: string;
  volume: number;
  verified: number;
  avgResponseSeconds: number;
}

export interface DashboardValueView {
  range: DashboardRange;
  from: number;
  to: number;
  /** 近 14 天真实草稿量（按租户时区分日） */
  trend: DashboardTrendPointView[];
  /** 当前时间窗口内的顾问真实产出 */
  advisorRanking: DashboardAdvisorRankView[];
  adoption: {
    original: number;
    revised: number;
    edited: number;
    sentTotal: number;
    rate: number;
    rateFormula: string;
  };
  savedMinutes: number;
  savedMinutesBasis: string;
  minutesPerDraft: number;
  proactiveCareCount: number;
  verificationPassRate: number;
  patientsPerAdvisor: number;
  computedAt: number;
}

export interface DashboardKpisView {
  range: DashboardRange;
  onlineAgents: number;
  proactiveToday: number;
  memoriesToday: number;
  draftsToday: number;
  verificationPassRate: number;
  avgResponseSeconds: number;
  openAlerts: number;
  computedAt: number;
}

export interface ServiceFlowRowView {
  id: string;
  source: 'inbound' | 'proactive';
  groupId: string;
  groupName: string;
  patientId: string;
  patientName: string;
  advisorId: string;
  advisorName: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: string;
  mediaKinds: string[];
  version: number;
  fallback: boolean;
  sandbox: boolean;
  demo: boolean;
  createdAt: number;
  durations: {
    inboundToDraftMs?: number;
    draftToPushMs?: number;
    pushToAckMs?: number;
    ackToVerifiedMs?: number;
  };
}

export interface ServiceFlowRevisionView {
  version: number;
  body: string;
  instruction: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ServiceFlowDetailView {
  draft: {
    id: string;
    body: string;
    version: number;
    revisions: ServiceFlowRevisionView[];
    sentVersion: number | null;
    riskLevel: string;
    status: string;
    ruleIds: string[];
    citedMemoryIds: string[];
    citedKnowledgeIds: string[];
    fallback: boolean;
    sandbox: boolean;
    demo: boolean;
    cardTaskId: string | null;
    pushAttempts: number;
    verifyAttempts: number;
    createdAt: number;
    pushedAt: number | null;
    ackedAt: number | null;
    verifiedAt: number | null;
    verificationId: string | null;
  };
  patient: { id: string; displayName: string };
  group: { id: string; name: string; roomId: string };
  advisor: { id: string; name: string };
  citations: {
    memories: Array<{ id: string; category: string; content: string; deletedAt: number | null }>;
    knowledge: Array<{ id: string; title: string; deletedAt: number | null }>;
  };
  deliveries: Array<{
    id: string;
    draftId: string;
    version: number;
    msgid: string;
    roomId: string;
    text: string;
    sentAt: number;
    source: string;
    sandbox: boolean;
    createdAt: number;
  }>;
  verification: {
    id: string;
    draftId: string;
    outcome: string;
    matchedMsgId: string | null;
    matchedRoomId: string | null;
    matchedGroupName: string | null;
    similarity: number | null;
    attempts: number;
    checkedAt: number;
    sandbox: boolean;
  } | null;
  timeline: Array<{ at: number; type: string; actor: string; title: string; detail?: string }>;
  audit: Array<{ id: string; action: string; actorName: string; result: string; at: number }>;
  media: Array<{ id: string; kind: string; url: string; label: string }>;
}

export interface PatientView {
  id: string;
  tenantId: string;
  displayName: string;
  avatar: string | null;
  externalUserId: string | null;
  /** 患者身份确认状态：pending=按发言猜测待确认；confirmed=顾问手动指定 */
  identityStatus: 'pending' | 'confirmed';
  /** 身份来源：auto=按发言自动猜测；manual=顾问在控制台确认/改绑 */
  identitySource: 'auto' | 'manual';
  identityConfirmedAt: number | null;
  tags: string[];
  advisorId: string | null;
  groupIds: string[];
  consent: string;
  consentCheckedAt: number | null;
  status: string;
  demo: boolean;
  accompaniedSince: number;
  lastActiveAt: number | null;
  memoryCount: number;
  pendingPlanCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface AdvisorView {
  id: string;
  tenantId: string;
  wecomUserId: string;
  name: string;
  status: string;
  seatExpireAt: number | null;
  chatBound: boolean;
  online: boolean;
  queueDepth: number;
  consecutiveMisroutes: number;
  pausedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineEventView {
  id: string;
  at: number;
  type:
    | 'inbound'
    | 'draft'
    | 'revision'
    | 'delivery'
    | 'verification'
    | 'memory'
    | 'care_plan'
    | 'alert'
    | 'note';
  actor: { type: 'patient' | 'agent' | 'advisor' | 'system'; name: string };
  title: string;
  detail: string | null;
  draftId: string | null;
  verificationOutcome: 'verified' | 'edit_sent' | 'misroute' | 'unverified' | null;
}

export interface AgentActionView {
  id: string;
  tenantId: string;
  patientId: string;
  draftId: string | null;
  tool: string;
  summary: string;
  result: 'success' | 'failed' | 'skipped';
  errorCode: string | null;
  createdAt: number;
  sandbox: boolean;
}

// ---------- 时间窗口 ----------

function timeZoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour12: false,
  }).formatToParts(new Date(at));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/** 租户时区当天 00:00 的时间戳（Asia/Shanghai 无夏令时）。 */
export function startOfZonedDay(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const utcMidnight = Date.UTC(year, month - 1, day);
  return utcMidnight - timeZoneOffsetMs(utcMidnight, timeZone);
}

export function rangeWindow(
  range: DashboardRange,
  now: number,
  timeZone: string,
): { range: DashboardRange; from: number; to: number } {
  const days = range === 'today' ? 1 : range === 'week' ? 7 : 30;
  return { range, from: startOfZonedDay(now, timeZone) - (days - 1) * 86_400_000, to: now };
}

function inWindow(at: number | undefined, from: number, to: number): boolean {
  return at !== undefined && at >= from && at <= to;
}

// ---------- 关联解析 ----------

export interface GroupLike {
  id: string;
  roomId: string;
  name: string;
  advisorId?: string;
  demo: boolean;
  deletedAt?: number;
}

export interface DraftLookups {
  patients: Patient[];
  groups: GroupLike[];
  bindings: GroupBinding[];
  advisors: AdvisorRecord[];
}

function livePatient(patient: Patient | undefined): Patient | undefined {
  return patient && patient.deletedAt === undefined ? patient : undefined;
}

export function draftGroup(draft: Draft, groups: GroupLike[]): GroupLike | undefined {
  return groups.find((group) => group.roomId === draft.groupRoomId && group.deletedAt === undefined);
}

export function draftPatient(draft: Draft, lookups: DraftLookups): Patient | undefined {
  const group = draftGroup(draft, lookups.groups);
  if (group) {
    const binding = lookups.bindings.find(
      (item) => item.groupId === group.id && item.deletedAt === undefined,
    );
    const bound = livePatient(lookups.patients.find((patient) => patient.id === binding?.patientId));
    if (bound) return bound;
  }
  return livePatient(
    lookups.patients.find(
      (patient) => patient.externalUserId && patient.externalUserId === draft.customerId,
    ),
  );
}

/**
 * 顾问归属：优先患者自身，其次患者绑定群的顾问。
 * 演示机早期数据里 patient.advisorId 为空，但群已映射到顾问。
 */
export function patientAdvisorId(
  patient: Patient,
  groups: GroupLike[],
  bindings: GroupBinding[],
): string | undefined {
  if (patient.advisorId) return patient.advisorId;
  const groupIds = new Set(
    bindings
      .filter((item) => item.patientId === patient.id && item.deletedAt === undefined)
      .map((item) => item.groupId),
  );
  for (const group of groups) {
    if (groupIds.has(group.id) && group.advisorId) return group.advisorId;
  }
  return undefined;
}

function advisorOnline(advisor: AdvisorRecord): boolean {
  return advisor.status === 'active';
}

// ---------- 服务流 ----------

function draftDuration(draft: Draft): ServiceFlowRowView['durations'] {
  return {
    ...(draft.lastInboundAt !== undefined
      ? { inboundToDraftMs: Math.max(0, draft.createdAt - draft.lastInboundAt) }
      : {}),
    ...(draft.pushedAt !== undefined
      ? { draftToPushMs: Math.max(0, draft.pushedAt - draft.createdAt) }
      : {}),
    ...(draft.pushedAt !== undefined && draft.ackAt !== undefined
      ? { pushToAckMs: Math.max(0, draft.ackAt - draft.pushedAt) }
      : {}),
    ...(draft.ackAt !== undefined && draft.verification?.checkedAt !== undefined
      ? { ackToVerifiedMs: Math.max(0, draft.verification.checkedAt - draft.ackAt) }
      : {}),
  };
}

function draftVersion(draft: Draft): number {
  if (draft.version !== undefined) return draft.version;
  const last = draft.revisions?.[draft.revisions.length - 1];
  return last?.version ?? 1;
}

export function serviceFlowRow(draft: Draft, lookups: DraftLookups): ServiceFlowRowView {
  const group = draftGroup(draft, lookups.groups);
  const patient = draftPatient(draft, lookups);
  const advisor =
    lookups.advisors.find((item) => item.id === draft.advisorId) ??
    (patient
      ? lookups.advisors.find(
          (item) => item.id === patientAdvisorId(patient, lookups.groups, lookups.bindings),
        )
      : undefined);
  return {
    id: draft.id,
    source: draft.source ?? 'inbound',
    groupId: group?.id ?? draft.groupRoomId,
    groupName: group?.name ?? draft.groupName,
    patientId: patient?.id ?? '',
    patientName: patient?.displayName ?? draft.customerName,
    advisorId: draft.advisorId,
    advisorName: advisor?.name ?? draft.advisorId,
    summary: draft.inboundSummary,
    riskLevel: draft.riskLevel,
    status: draft.status,
    mediaKinds:
      draft.mediaKinds && draft.mediaKinds.length > 0
        ? [...draft.mediaKinds]
        : (draft.mediaIds?.length ?? 0) > 0
          ? ['image']
          : [],
    version: draftVersion(draft),
    fallback: draft.fallback === true,
    sandbox: false,
    demo: group?.demo ?? patient?.demo ?? false,
    createdAt: draft.createdAt,
    durations: draftDuration(draft),
  };
}

const VERIFICATION_OUTCOME: Record<string, string> = {
  VERIFIED: 'verified',
  EDIT_SENT: 'edit_sent',
  MISROUTE_ALERT: 'misroute',
  UNVERIFIED: 'unverified',
};

function verificationTitle(outcome?: string): string {
  if (outcome === 'verified') return '核验通过';
  if (outcome === 'edit_sent') return '改稿后发送';
  if (outcome === 'misroute') return '发错群';
  if (outcome === 'unverified') return '未找到实发消息';
  return '等待核验';
}

/** 控制台媒体地址：存档绝对路径编码进路径，避免前端接触磁盘路径。 */
export function archiveMediaId(path: string): string {
  return `arc_${Buffer.from(path, 'utf8').toString('base64url')}`;
}

export function decodeArchiveMediaId(mediaId: string): string | undefined {
  if (!mediaId.startsWith('arc_')) return undefined;
  try {
    return Buffer.from(mediaId.slice(4), 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

export interface FlowDetailContext extends DraftLookups {
  evidence?: {
    sent?: { msgid: string; text: string; msgtime: number } | null;
  };
  memories?: MemoryRecord[];
  knowledge?: Array<{ id: string; title: string; deletedAt?: number }>;
  audits?: Array<{ at: number; actor: string; action: string; target: string; result: string }>;
}

export function serviceFlowDetail(draft: Draft, ctx: FlowDetailContext): ServiceFlowDetailView {
  const row = serviceFlowRow(draft, ctx);
  const group = draftGroup(draft, ctx.groups);
  const patient = draftPatient(draft, ctx);
  const advisor = ctx.advisors.find((item) => item.id === draft.advisorId);
  const version = draftVersion(draft);
  const revisions =
    draft.revisions && draft.revisions.length > 0
      ? draft.revisions.map((item) => ({
          version: item.version,
          body: item.body,
          instruction: item.instruction ?? null,
          createdBy: item.createdBy,
          createdAt: item.createdAt,
        }))
      : [{ version, body: draft.body, instruction: null, createdBy: 'agent', createdAt: draft.createdAt }];

  const outcome = draft.verification
    ? (VERIFICATION_OUTCOME[draft.verification.outcome] ?? draft.verification.outcome.toLowerCase())
    : undefined;
  const verification = draft.verification
    ? {
        id: `vrf_${draft.id}`,
        draftId: draft.id,
        outcome: outcome ?? 'unverified',
        matchedMsgId: draft.verification.matchedMsgId ?? null,
        matchedRoomId: draft.verification.matchedRoomId ?? null,
        matchedGroupName: group?.name ?? null,
        similarity: draft.verification.similarity ?? null,
        attempts: draft.verifyAttempts,
        checkedAt: draft.verification.checkedAt,
        sandbox: false,
      }
    : null;

  const sent = ctx.evidence?.sent;
  const deliveries =
    sent && draft.verification?.matchedMsgId
      ? [
          {
            id: `dly_${draft.id}`,
            draftId: draft.id,
            version: draft.sentVersion ?? version,
            msgid: sent.msgid,
            roomId: draft.verification.matchedRoomId ?? draft.groupRoomId,
            text: sent.text,
            sentAt: sent.msgtime,
            source: 'archive',
            sandbox: false,
            createdAt: draft.verification.checkedAt,
          },
        ]
      : [];

  const timeline: ServiceFlowDetailView['timeline'] = [];
  timeline.push({
    at: draft.lastInboundAt ?? draft.createdAt,
    type: draft.source === 'proactive' ? 'proactive' : 'inbound',
    actor: patient?.displayName ?? draft.customerName,
    title: draft.source === 'proactive' ? 'Agent 主动计划触发' : '客户发来消息',
    detail: draft.inboundSummary,
  });
  for (const revision of revisions) {
    timeline.push({
      at: revision.createdAt,
      type: 'draft',
      actor: revision.createdBy === 'staff' ? (advisor?.name ?? draft.advisorId) : 'Agent',
      title:
        revision.createdBy === 'staff'
          ? `顾问改稿（第 ${revision.version} 版）`
          : `生成第 ${revision.version} 版草稿`,
      detail: revision.body,
    });
  }
  if (draft.pushedAt !== undefined) {
    timeline.push({ at: draft.pushedAt, type: 'push', actor: 'system', title: '推送到顾问企微' });
  }
  if (draft.ackAt !== undefined) {
    timeline.push({
      at: draft.ackAt,
      type: 'ack',
      actor: advisor?.name ?? draft.advisorId,
      title: draft.ackAction === 'skipped' ? '已跳过' : '点击已发送',
    });
  }
  if (verification) {
    timeline.push({
      at: verification.checkedAt,
      type: 'verification',
      actor: 'system',
      title: verificationTitle(verification.outcome),
    });
  }
  timeline.sort((a, b) => a.at - b.at);

  const memories = ctx.memories ?? [];
  const knowledge = ctx.knowledge ?? [];
  const media = (draft.mediaIds ?? []).map((path) => ({
    id: archiveMediaId(path),
    kind: draft.mediaKinds?.[0] ?? 'image',
    url: '',
    label: draft.inboundSummary,
  }));

  return {
    draft: {
      id: draft.id,
      body: draft.body,
      version,
      revisions,
      sentVersion: draft.sentVersion ?? null,
      riskLevel: draft.riskLevel,
      status: draft.status,
      ruleIds: [...(draft.ruleIds ?? [])],
      citedMemoryIds: [...(draft.citedMemoryIds ?? [])],
      citedKnowledgeIds: [...(draft.citedKnowledgeIds ?? [])],
      fallback: draft.fallback === true,
      sandbox: false,
      demo: row.demo,
      cardTaskId: null,
      pushAttempts: draft.pushAttempts,
      verifyAttempts: draft.verifyAttempts,
      createdAt: draft.createdAt,
      pushedAt: draft.pushedAt ?? null,
      ackedAt: draft.ackAt ?? null,
      verifiedAt: draft.verification?.checkedAt ?? null,
      verificationId: draft.verification ? `vrf_${draft.id}` : null,
    },
    patient: { id: patient?.id ?? '', displayName: patient?.displayName ?? draft.customerName },
    group: {
      id: group?.id ?? draft.groupRoomId,
      name: group?.name ?? draft.groupName,
      roomId: draft.groupRoomId,
    },
    advisor: { id: draft.advisorId, name: advisor?.name ?? draft.advisorId },
    citations: {
      memories: (draft.citedMemoryIds ?? [])
        .map((id) => memories.find((item) => item.id === id))
        .filter((item): item is MemoryRecord => item !== undefined)
        .map((item) => ({
          id: item.id,
          category: item.category,
          content: item.content,
          deletedAt: item.deletedAt ?? null,
        })),
      knowledge: (draft.citedKnowledgeIds ?? [])
        .map((id) => knowledge.find((item) => item.id === id))
        .filter((item): item is { id: string; title: string; deletedAt?: number } => item !== undefined)
        .map((item) => ({ id: item.id, title: item.title, deletedAt: item.deletedAt ?? null })),
    },
    deliveries,
    verification,
    timeline,
    audit: (ctx.audits ?? [])
      .filter((item) => item.target === draft.id)
      .sort((a, b) => a.at - b.at)
      .map((item, index) => ({
        id: `aud_${draft.id}_${index + 1}`,
        action: item.action,
        actorName: item.actor,
        result: item.result,
        at: item.at,
      })),
    media,
  };
}

// ---------- 患者 / 顾问 ----------

export function patientView(
  patient: Patient,
  opts: {
    groupIds: string[];
    advisorId?: string;
    memoryCount: number;
    pendingPlanCount: number;
  },
): PatientView {
  return {
    id: patient.id,
    tenantId: patient.tenantId,
    displayName: patient.displayName,
    avatar: patient.avatar ?? null,
    externalUserId: patient.externalUserId ?? null,
    identityStatus: patient.identityStatus ?? 'pending',
    identitySource: patient.identitySource ?? 'auto',
    identityConfirmedAt: patient.identityConfirmedAt ?? null,
    tags: [...patient.tags],
    advisorId: opts.advisorId ?? patient.advisorId ?? null,
    groupIds: [...opts.groupIds],
    consent: patient.consent,
    consentCheckedAt: patient.consentCheckedAt ?? null,
    status: patient.status,
    demo: patient.demo,
    accompaniedSince: patient.accompaniedSince,
    lastActiveAt: patient.lastActiveAt ?? null,
    memoryCount: opts.memoryCount,
    pendingPlanCount: opts.pendingPlanCount,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
    deletedAt: patient.deletedAt ?? null,
  };
}

export function advisorView(advisor: AdvisorRecord, queueDepth: number): AdvisorView {
  return {
    id: advisor.id,
    tenantId: advisor.tenantId,
    wecomUserId: advisor.wecomUserId,
    name: advisor.name,
    status: advisor.status,
    seatExpireAt: advisor.seatExpireAt ?? null,
    chatBound: advisor.chatBound,
    online: advisorOnline(advisor),
    queueDepth,
    consecutiveMisroutes: advisor.consecutiveMisroutes,
    pausedAt: null,
    createdAt: advisor.createdAt,
    updatedAt: advisor.updatedAt,
  };
}

// ---------- 工作台 ----------

function hasStaffRevision(draft: Draft): boolean {
  return (draft.revisions ?? []).some((item) => item.createdBy === 'staff');
}

/** 近 N 天（含今天）的真实草稿量，按租户时区分日。 */
export function dashboardTrend(
  drafts: Draft[],
  now: number,
  timeZone: string,
  days = 14,
): DashboardTrendPointView[] {
  const todayStart = startOfZonedDay(now, timeZone);
  const points: DashboardTrendPointView[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dayStart = todayStart - offset * 86_400_000;
    const key = dayKey(dayStart, timeZone);
    const dayDrafts = drafts.filter((draft) => dayKey(draft.createdAt, timeZone) === key);
    points.push({
      date: key,
      label: key.slice(5),
      volume: dayDrafts.length,
      verified: dayDrafts.filter((draft) => draft.status === 'VERIFIED').length,
    });
  }
  return points;
}

/** 当前窗口内每位顾问的真实草稿量与平均响应，按草稿量倒序。 */
export function dashboardAdvisorRanking(
  drafts: Draft[],
  advisors: AdvisorRecord[],
): DashboardAdvisorRankView[] {
  return advisors
    .map((advisor) => {
      const owned = drafts.filter((draft) => draft.advisorId === advisor.id);
      const samples = owned
        .filter((draft) => draft.lastInboundAt !== undefined)
        .map((draft) => Math.max(0, draft.createdAt - (draft.lastInboundAt ?? draft.createdAt)));
      return {
        advisorId: advisor.id,
        name: advisor.name,
        status: advisor.status,
        volume: owned.length,
        verified: owned.filter((draft) => draft.status === 'VERIFIED').length,
        avgResponseSeconds:
          samples.length === 0
            ? 0
            : Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length / 1000),
      };
    })
    .sort(
      (left, right) => right.volume - left.volume || left.name.localeCompare(right.name, 'zh-CN'),
    );
}

export function dashboardValue(input: {
  range: DashboardRange;
  now: number;
  timeZone: string;
  minutesPerDraft: number;
  drafts: Draft[];
  patients: Patient[];
  advisors: AdvisorRecord[];
  carePlans: CarePlanRecord[];
}): DashboardValueView {
  const window = rangeWindow(input.range, input.now, input.timeZone);
  const drafts = input.drafts.filter((draft) => inWindow(draft.createdAt, window.from, window.to));
  const sent = drafts.filter((draft) => draft.ackAction === 'sent');
  const verified = sent.filter((draft) => draft.status === 'VERIFIED');
  const revised = verified.filter(
    (draft) => hasStaffRevision(draft) || (draft.sentVersion ?? 1) > 1,
  ).length;
  const original = verified.length - revised;
  const edited = sent.filter((draft) => draft.status === 'EDIT_SENT').length;
  const sentTotal = sent.length;
  const rate = sentTotal === 0 ? 0 : (original + revised) / sentTotal;
  const savedMinutes = (original + revised) * input.minutesPerDraft;
  const activeAdvisors = input.advisors.filter((advisor) => advisor.status === 'active').length;
  const activePatients = input.patients.filter(
    (patient) => patient.deletedAt === undefined && patient.status !== 'archived',
  ).length;
  const trend = dashboardTrend(input.drafts, input.now, input.timeZone, 14);
  const ranking = dashboardAdvisorRanking(drafts, input.advisors);
  return {
    range: window.range,
    from: window.from,
    to: window.to,
    trend,
    advisorRanking: ranking,
    adoption: {
      original,
      revised,
      edited,
      sentTotal,
      rate,
      rateFormula: `（原样 ${original} + 改稿后 ${revised}）/ 已发出 ${sentTotal}`,
    },
    savedMinutes,
    savedMinutesBasis: `（原样 ${original} + 改稿后 ${revised}）× ${input.minutesPerDraft} 分钟`,
    minutesPerDraft: input.minutesPerDraft,
    proactiveCareCount: input.carePlans.filter((plan) =>
      inWindow(plan.lastFiredAt, window.from, window.to),
    ).length,
    verificationPassRate: sentTotal === 0 ? 0 : verified.length / sentTotal,
    patientsPerAdvisor:
      activeAdvisors === 0 ? 0 : Math.round((activePatients / activeAdvisors) * 10) / 10,
    computedAt: input.now,
  };
}

export function dashboardKpis(input: {
  range: DashboardRange;
  now: number;
  timeZone: string;
  drafts: Draft[];
  advisors: AdvisorRecord[];
  memories: MemoryRecord[];
  openAlerts: number;
}): DashboardKpisView {
  const window = rangeWindow(input.range, input.now, input.timeZone);
  const drafts = input.drafts.filter((draft) => inWindow(draft.createdAt, window.from, window.to));
  const sent = drafts.filter((draft) => draft.ackAction === 'sent');
  const verified = sent.filter((draft) => draft.status === 'VERIFIED').length;
  const responseSamples = drafts
    .filter((draft) => draft.lastInboundAt !== undefined)
    .map((draft) => Math.max(0, draft.createdAt - (draft.lastInboundAt ?? draft.createdAt)));
  const avgResponseSeconds =
    responseSamples.length === 0
      ? 0
      : Math.round(responseSamples.reduce((sum, value) => sum + value, 0) / responseSamples.length / 1000);
  return {
    range: window.range,
    onlineAgents: input.advisors.filter((advisor) => advisor.status === 'active').length,
    proactiveToday: drafts.filter((draft) => draft.source === 'proactive').length,
    memoriesToday: input.memories.filter((memory) => inWindow(memory.createdAt, window.from, window.to))
      .length,
    draftsToday: drafts.length,
    verificationPassRate: sent.length === 0 ? 0 : verified / sent.length,
    avgResponseSeconds,
    openAlerts: input.openAlerts,
    computedAt: input.now,
  };
}

// ---------- 患者时间线 / 办事记录 ----------

export function buildPatientTimeline(input: {
  patient: Patient;
  drafts: Draft[];
  memories: MemoryRecord[];
  carePlans: CarePlanRecord[];
  alerts: Array<{ id: string; title: string; message: string; createdAt: number }>;
}): TimelineEventView[] {
  const events: TimelineEventView[] = [];
  for (const draft of input.drafts) {
    if (draft.lastInboundAt !== undefined) {
      events.push({
        id: `evt_${draft.id}_inbound`,
        at: draft.lastInboundAt,
        type: 'inbound',
        actor: { type: 'patient', name: input.patient.displayName },
        title: '客户发来消息',
        detail: draft.inboundSummary,
        draftId: draft.id,
        verificationOutcome: null,
      });
    }
    for (const revision of draft.revisions ?? []) {
      events.push({
        id: `evt_${draft.id}_v${revision.version}`,
        at: revision.createdAt,
        type: 'revision',
        actor: {
          type: revision.createdBy === 'staff' ? 'advisor' : 'agent',
          name: revision.createdBy === 'staff' ? '顾问' : 'Agent',
        },
        title:
          revision.createdBy === 'staff'
            ? `顾问改稿（第 ${revision.version} 版）`
            : `生成第 ${revision.version} 版草稿`,
        detail: revision.body,
        draftId: draft.id,
        verificationOutcome: null,
      });
    }
    if (draft.verification) {
      const outcome =
        VERIFICATION_OUTCOME[draft.verification.outcome] ??
        draft.verification.outcome.toLowerCase();
      events.push({
        id: `evt_${draft.id}_verify`,
        at: draft.verification.checkedAt,
        type: 'verification',
        actor: { type: 'system', name: 'system' },
        title: verificationTitle(outcome),
        detail: `相似度 ${draft.verification.similarity ?? '-'}`,
        draftId: draft.id,
        verificationOutcome: outcome as TimelineEventView['verificationOutcome'],
      });
    }
  }
  for (const memory of input.memories) {
    if (memory.deletedAt !== undefined) continue;
    events.push({
      id: `evt_${memory.id}`,
      at: memory.createdAt,
      type: 'memory',
      actor: { type: memory.createdBy === 'staff' ? 'advisor' : 'agent', name: memory.createdBy === 'staff' ? '顾问' : 'Agent' },
      title: '记录记忆',
      detail: memory.content,
      draftId: null,
      verificationOutcome: null,
    });
  }
  for (const plan of input.carePlans) {
    events.push({
      id: `evt_${plan.id}`,
      at: plan.createdAt,
      type: 'care_plan',
      actor: { type: plan.source === 'staff' ? 'advisor' : 'agent', name: plan.source === 'staff' ? '顾问' : 'Agent' },
      title: plan.status === 'cancelled' ? '取消主动计划' : '创建主动计划',
      detail: plan.title,
      draftId: null,
      verificationOutcome: null,
    });
  }
  for (const alert of input.alerts) {
    events.push({
      id: `evt_${alert.id}`,
      at: alert.createdAt,
      type: 'alert',
      actor: { type: 'system', name: 'system' },
      title: alert.title,
      detail: alert.message,
      draftId: null,
      verificationOutcome: null,
    });
  }
  return events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function buildPatientActions(input: {
  patient: Patient;
  tenantId: string;
  drafts: Draft[];
  carePlans: CarePlanRecord[];
  memories: MemoryRecord[];
}): AgentActionView[] {
  const actions: AgentActionView[] = [];
  for (const draft of input.drafts) {
    const failed = draft.status === 'FAILED' || draft.status === 'DEAD_LETTER';
    const skipped = draft.ackAction === 'skipped' || draft.status === 'SKIPPED';
    actions.push({
      id: `act_${draft.id}`,
      tenantId: input.tenantId,
      patientId: input.patient.id,
      draftId: draft.id,
      tool: skipped ? 'reply_skip' : 'reply_draft',
      summary: skipped
        ? `跳过回复：${draft.inboundSummary}`
        : `生成回复草稿：${draft.inboundSummary}`,
      result: failed ? 'failed' : skipped ? 'skipped' : 'success',
      errorCode: failed ? (draft.errorCode ?? null) : null,
      createdAt: draft.createdAt,
      sandbox: false,
    });
  }
  for (const memory of input.memories) {
    if (memory.deletedAt !== undefined) continue;
    actions.push({
      id: `act_${memory.id}`,
      tenantId: input.tenantId,
      patientId: input.patient.id,
      draftId: null,
      tool: 'memory_write',
      summary: `记录记忆：${memory.content}`,
      result: 'success',
      errorCode: null,
      createdAt: memory.createdAt,
      sandbox: memory.sandbox,
    });
  }
  for (const plan of input.carePlans) {
    actions.push({
      id: `act_${plan.id}`,
      tenantId: input.tenantId,
      patientId: input.patient.id,
      draftId: null,
      tool: 'schedule_create',
      summary: `创建主动计划：${plan.title}`,
      result: plan.status === 'cancelled' ? 'skipped' : 'success',
      errorCode: null,
      createdAt: plan.createdAt,
      sandbox: plan.sandbox,
    });
  }
  return actions.sort((a, b) => b.createdAt - a.createdAt);
}
