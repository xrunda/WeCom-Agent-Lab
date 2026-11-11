/**
 * 控制台真实数据视图（docs/P1-api.md §4–§8）。
 *
 * 患者域 / 企微域只提供领域记录，控制台在这里把记录翻成前端契约。
 * 纯函数、无 I/O：沙盒数据不计入工作台，所有统计都只基于传入的真实记录。
 */
import type { Draft } from '../c2/types.ts';
import { dayKey } from './console-types.ts';
import type { AlertRecord } from './console-types.ts';
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
    ruleNames: string[];
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
  /** 员工发言命中红线的累计条数（按 advisorId 统计），作为个人考核留痕 */
  redlineHits: number;
  /** 其中尚未处理（open + acknowledged）的条数 */
  redlineOpen: number;
  /** 最近一次命中时间；没有命中为 null */
  redlineLastAt: number | null;
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
  /** 群当前服务状态；团队关注用它排除未开始服务的群 */
  status?: string;
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
      ruleNames: [...(draft.ruleNames ?? [])],
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

export function advisorView(
  advisor: AdvisorRecord,
  queueDepth: number,
  redline: { hits: number; open: number; lastAt: number | null } = {
    hits: 0,
    open: 0,
    lastAt: null,
  },
): AdvisorView {
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
    redlineHits: redline.hits,
    redlineOpen: redline.open,
    redlineLastAt: redline.lastAt,
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

// ---------- 团队关注（工作台） ----------

export type TeamAttentionLevel = 'L1' | 'L2';

export type TeamAttentionCode =
  | 'redline'
  | 'misroute'
  | 'unverified'
  | 'advisor_paused'
  | 'queue_blocked'
  | 'no_reply'
  | 'backlog'
  | 'slow_response'
  | 'high_revision';

export interface TeamAttentionReasonView {
  code: TeamAttentionCode;
  level: TeamAttentionLevel;
  text: string;
  waitMinutes: number;
  draftId?: string;
  patientId?: string;
  groupId?: string;
}

export interface TeamAttentionPersonView {
  advisorId: string;
  advisorName: string;
  online: boolean;
  patientCount: number;
  pendingCount: number;
  level: TeamAttentionLevel;
  reasons: TeamAttentionReasonView[];
  suggestion: string;
  oldestWaitMinutes: number;
  lastActivityAt: number | null;
}

export interface TeamAttentionView {
  generatedAt: number;
  people: TeamAttentionPersonView[];
  summary: {
    peopleCount: number;
    immediateCount: number;
    verifiedToday: number;
    avgResponseSeconds: number;
    unverifiedCount: number;
  };
}

/** 团队关注的阈值集中在这里，文档与测试引用同一组数字。 */
export const TEAM_ATTENTION_THRESHOLDS = {
  queueBlockedMinutes: 15,
  noReplyL2Minutes: 30,
  noReplyL1Minutes: 60,
  backlogCount: 3,
  slowResponseMinutes: 10,
  slowResponseRatio: 2,
  revisionRate: 0.4,
  minRevisionDrafts: 4,
  minResponseSamples: 2,
} as const;

const TEAM_ATTENTION_PRIORITY: Record<TeamAttentionCode, number> = {
  redline: 1,
  misroute: 2,
  unverified: 3,
  queue_blocked: 4,
  no_reply: 5,
  advisor_paused: 6,
  backlog: 7,
  slow_response: 8,
  high_revision: 9,
};

const TEAM_ATTENTION_SUGGESTION: Record<TeamAttentionCode, string> = {
  redline: '去质检与告警跟进高风险草稿',
  misroute: '去质检与告警核对发送群',
  unverified: '去质检与告警核实是否送达',
  advisor_paused: '去质检与告警查看暂停原因',
  queue_blocked: '去实时服务流查看阻塞草稿，必要时在告警台账释放队列',
  no_reply: '查看对话，确认服务人员是否在忙，必要时转交',
  backlog: '查看待处理草稿，确认是否需要催办或释放队列',
  slow_response: '查看该服务人员的服务流，确认是否负荷过高',
  high_revision: '查看草稿质量，必要时调整话术或补充知识',
};

interface TeamAttentionAccumulator {
  advisorId: string;
  reasons: TeamAttentionReasonView[];
  pendingCount: number;
  patientCount: number;
  lastActivityAt: number | null;
}

function minutesSince(now: number, at: number): number {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

function teamAttentionLevelOf(reasons: TeamAttentionReasonView[]): TeamAttentionLevel {
  return reasons.some((reason) => reason.level === 'L1') ? 'L1' : 'L2';
}

/**
 * 工作台的「团队关注」：按服务人员聚合需要管理员介入的事项。
 *
 * 只输出行为元数据（谁、哪类事件、等了多久、去哪里看），不带消息正文或健康数值。
 * 事件级台账仍在质检与告警，这里只做发现与跳转。
 */
export function dashboardTeamAttention(input: {
  now: number;
  timeZone: string;
  drafts: Draft[];
  patients: Patient[];
  advisors: AdvisorRecord[];
  groups: GroupLike[];
  bindings: GroupBinding[];
  alerts: AlertRecord[];
}): TeamAttentionView {
  const { now } = input;
  const patients = input.patients.filter((patient) => patient.deletedAt === undefined);
  const lookups: DraftLookups = {
    patients,
    groups: input.groups,
    bindings: input.bindings,
    advisors: input.advisors,
  };
  const advisorById = new Map(input.advisors.map((advisor) => [advisor.id, advisor]));
  const patientById = new Map(patients.map((patient) => [patient.id, patient]));
  const draftById = new Map(input.drafts.map((draft) => [draft.id, draft]));
  const patientAdvisorCache = new Map<string, string | undefined>();
  const accumulators = new Map<string, TeamAttentionAccumulator>();

  const advisorOfPatient = (patient: Patient): string | undefined => {
    if (!patientAdvisorCache.has(patient.id)) {
      patientAdvisorCache.set(patient.id, patientAdvisorId(patient, input.groups, input.bindings));
    }
    return patientAdvisorCache.get(patient.id);
  };

  const advisorOfAlert = (alert: AlertRecord): string | undefined => {
    if (alert.advisorId && advisorById.has(alert.advisorId)) return alert.advisorId;
    const draft = alert.draftId ? draftById.get(alert.draftId) : undefined;
    if (draft && advisorById.has(draft.advisorId)) return draft.advisorId;
    const patient = alert.patientId ? patientById.get(alert.patientId) : undefined;
    const fromPatient = patient ? advisorOfPatient(patient) : undefined;
    return fromPatient && advisorById.has(fromPatient) ? fromPatient : undefined;
  };

  const accumulatorFor = (advisorId: string): TeamAttentionAccumulator | undefined => {
    if (!advisorById.has(advisorId)) return undefined;
    let accumulator = accumulators.get(advisorId);
    if (!accumulator) {
      accumulator = {
        advisorId,
        reasons: [],
        pendingCount: 0,
        patientCount: 0,
        lastActivityAt: null,
      };
      accumulators.set(advisorId, accumulator);
    }
    return accumulator;
  };

  const addReason = (advisorId: string, reason: TeamAttentionReasonView): void => {
    const accumulator = accumulatorFor(advisorId);
    if (!accumulator) return;
    if (accumulator.reasons.some((item) => item.code === reason.code)) return;
    accumulator.reasons.push(reason);
  };

  // 先为每位服务人员建立聚合槽，后续积压/慢响应/改稿率才能落到没有告警的人身上。
  for (const advisor of input.advisors) accumulatorFor(advisor.id);

  // 告警类：只取未解决（open / acknowledged）的真实告警。
  const alertTargetAdvisor = new Map<string, string>();
  for (const alert of input.alerts) {
    if (alert.sandbox || alert.status === 'resolved') continue;
    const advisorId = advisorOfAlert(alert);
    if (advisorId) alertTargetAdvisor.set(alert.id, advisorId);
  }

  const alertGroups = new Map<string, AlertRecord[]>();
  for (const alert of input.alerts) {
    if (!alertTargetAdvisor.has(alert.id)) continue;
    if (!['redline', 'misroute', 'unverified', 'advisor_paused'].includes(alert.kind)) continue;
    const key = `${alert.kind}|${alertTargetAdvisor.get(alert.id)}`;
    const list = alertGroups.get(key) ?? [];
    list.push(alert);
    alertGroups.set(key, list);
  }

  for (const [key, list] of alertGroups) {
    const [kind, advisorId] = key.split('|') as [TeamAttentionCode, string];
    const oldest = list.reduce((left, right) => (left.createdAt <= right.createdAt ? left : right));
    const waitMinutes = minutesSince(now, oldest.createdAt);
    const text =
      kind === 'redline'
        ? `高风险草稿 ${list.length} 条待处理`
        : kind === 'misroute'
          ? `发错群 ${list.length} 条待核对`
          : kind === 'unverified'
            ? `未核验 ${list.length} 条待核实`
            : `服务人员暂停告警 ${list.length} 条待处理`;
    addReason(advisorId, {
      code: kind,
      level: 'L1',
      text,
      waitMinutes,
      ...(oldest.draftId ? { draftId: oldest.draftId } : {}),
      ...(oldest.patientId ? { patientId: oldest.patientId } : {}),
      ...(oldest.groupId ? { groupId: oldest.groupId } : {}),
    });
  }

  // 顾问账号被暂停，即使没有对应告警也要提示。
  for (const advisor of input.advisors) {
    if (advisor.status !== 'paused') continue;
    const accumulator = accumulatorFor(advisor.id);
    if (!accumulator) continue;
    if (accumulator.reasons.some((reason) => reason.code === 'advisor_paused')) continue;
    accumulator.reasons.push({
      code: 'advisor_paused',
      level: 'L1',
      text: '账号处于暂停状态，需确认是否恢复',
      waitMinutes: 0,
    });
  }

  // 队列阻塞：已推送超过 15 分钟仍未处理。
  const blockedByAdvisor = new Map<string, Draft[]>();
  for (const draft of input.drafts) {
    if (draft.status !== 'PUSHED') continue;
    const since = draft.pushedAt ?? draft.createdAt;
    if (minutesSince(now, since) < TEAM_ATTENTION_THRESHOLDS.queueBlockedMinutes) continue;
    const list = blockedByAdvisor.get(draft.advisorId) ?? [];
    list.push(draft);
    blockedByAdvisor.set(draft.advisorId, list);
  }
  for (const [advisorId, list] of blockedByAdvisor) {
    const oldest = list.reduce((left, right) =>
      (left.pushedAt ?? left.createdAt) <= (right.pushedAt ?? right.createdAt) ? left : right,
    );
    const waitMinutes = minutesSince(now, oldest.pushedAt ?? oldest.createdAt);
    const patient = draftPatient(oldest, lookups);
    const accumulator = accumulatorFor(advisorId);
    if (!accumulator) continue;
    accumulator.reasons.push({
      code: 'queue_blocked',
      level: 'L1',
      text:
        list.length === 1
          ? `草稿已推送 ${waitMinutes} 分钟未处理，队列可能阻塞`
          : `队列阻塞 ${list.length} 条，最久已等待 ${waitMinutes} 分钟`,
      waitMinutes,
      draftId: oldest.id,
      ...(patient ? { patientId: patient.id } : {}),
      groupId: oldest.groupRoomId,
    });
  }

  // 客户消息无人跟进：最新客户消息晚于该患者最新草稿，且已超过 30 分钟。
  const latestDraftAtByPatient = new Map<string, number>();
  const latestActivityByAdvisor = new Map<string, number>();
  for (const draft of input.drafts) {
    const patient = draftPatient(draft, lookups);
    if (patient) {
      latestDraftAtByPatient.set(
        patient.id,
        Math.max(latestDraftAtByPatient.get(patient.id) ?? 0, draft.createdAt),
      );
    }
    const touched = Math.max(
      draft.createdAt,
      draft.pushedAt ?? 0,
      draft.ackAt ?? 0,
      draft.verification?.checkedAt ?? 0,
    );
    latestActivityByAdvisor.set(
      draft.advisorId,
      Math.max(latestActivityByAdvisor.get(draft.advisorId) ?? 0, touched),
    );
  }

  const longestNoReplyByAdvisor = new Map<string, { patient: Patient; waitMinutes: number }>();
  for (const patient of patients) {
    if (patient.status !== 'serving' || patient.consent === 'disagreed') continue;
    if (patient.lastActiveAt === undefined) continue;
    const waitMinutes = minutesSince(now, patient.lastActiveAt);
    if (waitMinutes < TEAM_ATTENTION_THRESHOLDS.noReplyL2Minutes) continue;
    if ((latestDraftAtByPatient.get(patient.id) ?? 0) >= patient.lastActiveAt) continue;
    const advisorId = advisorOfPatient(patient);
    if (!advisorId || !advisorById.has(advisorId)) continue;
    const current = longestNoReplyByAdvisor.get(advisorId);
    if (!current || waitMinutes > current.waitMinutes) {
      longestNoReplyByAdvisor.set(advisorId, { patient, waitMinutes });
    }
    latestActivityByAdvisor.set(
      advisorId,
      Math.max(latestActivityByAdvisor.get(advisorId) ?? 0, patient.lastActiveAt),
    );
  }
  for (const [advisorId, item] of longestNoReplyByAdvisor) {
    const accumulator = accumulatorFor(advisorId);
    if (!accumulator) continue;
    accumulator.reasons.push({
      code: 'no_reply',
      level: item.waitMinutes >= TEAM_ATTENTION_THRESHOLDS.noReplyL1Minutes ? 'L1' : 'L2',
      text: `客户消息 ${item.waitMinutes} 分钟无人跟进`,
      waitMinutes: item.waitMinutes,
      patientId: item.patient.id,
      ...(item.patient.groupIds?.[0] ? { groupId: item.patient.groupIds[0] } : {}),
    });
  }

  // 待处理积压与今日响应/改稿质量。
  const today = rangeWindow('today', now, input.timeZone);
  const todayDrafts = input.drafts.filter((draft) => inWindow(draft.createdAt, today.from, today.to));
  const todayResponseByAdvisor = new Map<string, number[]>();
  for (const draft of todayDrafts) {
    if (draft.lastInboundAt === undefined) continue;
    const samples = todayResponseByAdvisor.get(draft.advisorId) ?? [];
    samples.push(Math.max(0, draft.createdAt - draft.lastInboundAt));
    todayResponseByAdvisor.set(draft.advisorId, samples);
  }
  const allResponseSamples = [...todayResponseByAdvisor.values()].flat();
  const teamAvgMs =
    allResponseSamples.length === 0
      ? 0
      : allResponseSamples.reduce((sum, value) => sum + value, 0) / allResponseSamples.length;

  const todayByAdvisor = new Map<string, Draft[]>();
  for (const draft of todayDrafts) {
    const list = todayByAdvisor.get(draft.advisorId) ?? [];
    list.push(draft);
    todayByAdvisor.set(draft.advisorId, list);
  }

  const pendingByAdvisor = new Map<string, Draft[]>();
  for (const accumulator of accumulators.values()) {
    for (const patient of patients) {
      if (patient.status === 'archived') continue;
      if (advisorOfPatient(patient) === accumulator.advisorId) accumulator.patientCount += 1;
    }
    const pending = input.drafts.filter(
      (draft) =>
        draft.advisorId === accumulator.advisorId &&
        (draft.status === 'QUEUED' || draft.status === 'PUSHED'),
    );
    accumulator.pendingCount = pending.length;
    pendingByAdvisor.set(accumulator.advisorId, pending);
    const latest = latestActivityByAdvisor.get(accumulator.advisorId);
    accumulator.lastActivityAt = latest ?? null;
  }

  for (const accumulator of accumulators.values()) {
    const pending = pendingByAdvisor.get(accumulator.advisorId) ?? [];
    if (pending.length > TEAM_ATTENTION_THRESHOLDS.backlogCount) {
      const oldest = pending.reduce((left, right) => {
        const leftAt = left.pushedAt ?? left.createdAt;
        const rightAt = right.pushedAt ?? right.createdAt;
        return leftAt <= rightAt ? left : right;
      });
      const waitMinutes = minutesSince(now, oldest.pushedAt ?? oldest.createdAt);
      const patient = draftPatient(oldest, lookups);
      accumulator.reasons.push({
        code: 'backlog',
        level: 'L2',
        text: `待处理草稿 ${pending.length} 条，超过 ${TEAM_ATTENTION_THRESHOLDS.backlogCount} 条`,
        waitMinutes,
        draftId: oldest.id,
        ...(patient ? { patientId: patient.id } : {}),
        groupId: oldest.groupRoomId,
      });
    }

    const samples = todayResponseByAdvisor.get(accumulator.advisorId) ?? [];
    if (
      samples.length >= TEAM_ATTENTION_THRESHOLDS.minResponseSamples &&
      teamAvgMs > 0
    ) {
      const advisorAvgMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      if (
        advisorAvgMs >= TEAM_ATTENTION_THRESHOLDS.slowResponseMinutes * 60_000 &&
        advisorAvgMs >= teamAvgMs * TEAM_ATTENTION_THRESHOLDS.slowResponseRatio
      ) {
        accumulator.reasons.push({
          code: 'slow_response',
          level: 'L2',
          text: `今日平均响应 ${Math.round(advisorAvgMs / 60_000)} 分钟，高于团队均值 2 倍`,
          waitMinutes: 0,
        });
      }
    }

    const todays = todayByAdvisor.get(accumulator.advisorId) ?? [];
    if (todays.length >= TEAM_ATTENTION_THRESHOLDS.minRevisionDrafts) {
      const acted = todays.filter(
        (draft) => hasStaffRevision(draft) || draft.ackAction === 'skipped',
      ).length;
      if (acted / todays.length >= TEAM_ATTENTION_THRESHOLDS.revisionRate) {
        accumulator.reasons.push({
          code: 'high_revision',
          level: 'L2',
          text: `今日 ${todays.length} 条草稿中 ${acted} 条改稿或忽略（${Math.round(
            (acted / todays.length) * 100,
          )}%）`,
          waitMinutes: 0,
        });
      }
    }
  }

  const people: TeamAttentionPersonView[] = [];
  for (const accumulator of accumulators.values()) {
    if (accumulator.reasons.length === 0) continue;
    const advisor = advisorById.get(accumulator.advisorId);
    if (!advisor) continue;
    accumulator.reasons.sort(
      (left, right) =>
        TEAM_ATTENTION_PRIORITY[left.code] - TEAM_ATTENTION_PRIORITY[right.code] ||
        right.waitMinutes - left.waitMinutes,
    );
    const level = teamAttentionLevelOf(accumulator.reasons);
    const oldestWaitMinutes = Math.max(
      0,
      ...accumulator.reasons.map((reason) => reason.waitMinutes),
    );
    people.push({
      advisorId: accumulator.advisorId,
      advisorName: advisor.name,
      online: advisorOnline(advisor),
      patientCount: accumulator.patientCount,
      pendingCount: accumulator.pendingCount,
      level,
      reasons: accumulator.reasons,
      suggestion: TEAM_ATTENTION_SUGGESTION[accumulator.reasons[0]?.code ?? 'backlog'],
      oldestWaitMinutes,
      lastActivityAt: accumulator.lastActivityAt,
    });
  }
  people.sort(
    (left, right) =>
      (left.level === right.level ? 0 : left.level === 'L1' ? -1 : 1) ||
      TEAM_ATTENTION_PRIORITY[left.reasons[0]?.code ?? 'high_revision'] -
        TEAM_ATTENTION_PRIORITY[right.reasons[0]?.code ?? 'high_revision'] ||
      right.oldestWaitMinutes - left.oldestWaitMinutes ||
      left.advisorName.localeCompare(right.advisorName, 'zh-CN'),
  );

  const sentToday = todayDrafts.filter((draft) => draft.ackAction === 'sent');
  const verifiedToday = sentToday.filter((draft) => draft.status === 'VERIFIED').length;
  const avgResponseSeconds =
    allResponseSamples.length === 0
      ? 0
      : Math.round(
          allResponseSamples.reduce((sum, value) => sum + value, 0) / allResponseSamples.length / 1000,
        );
  const unverifiedCount = input.alerts.filter(
    (alert) =>
      !alert.sandbox && alert.status !== 'resolved' && alert.kind === 'unverified',
  ).length;

  return {
    generatedAt: now,
    people,
    summary: {
      peopleCount: people.length,
      immediateCount: people.filter((person) => person.level === 'L1').length,
      verifiedToday,
      avgResponseSeconds,
      unverifiedCount,
    },
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
    const createdActor =
      memory.createdBy === 'staff'
        ? { type: 'advisor' as const, name: '顾问' }
        : { type: 'agent' as const, name: 'Agent' };
    const revised = memory.revisedAt !== undefined && memory.revisedAt > memory.createdAt;
    events.push({
      id: `evt_${memory.id}`,
      at: memory.createdAt,
      type: 'memory',
      actor: createdActor,
      title: '记录记忆',
      // 修正过的记忆不能把新内容倒填到旧时间点：优先展示当时的来源原话
      detail: revised ? (memory.sourceText ?? memory.content) : memory.content,
      draftId: null,
      verificationOutcome: null,
    });
    if (revised) {
      events.push({
        id: `evt_${memory.id}_revised_${memory.revisedAt}`,
        at: memory.revisedAt!,
        type: 'memory',
        actor:
          memory.updatedBy === 'staff'
            ? { type: 'advisor', name: '顾问' }
            : { type: 'agent', name: 'Agent' },
        title: '修正记忆',
        detail: memory.content,
        draftId: null,
        verificationOutcome: null,
      });
    }
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
  // 时间线按最新在前返回：配合 page/pageSize 分页时，第一页永远是最新事件。
  return events.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
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
