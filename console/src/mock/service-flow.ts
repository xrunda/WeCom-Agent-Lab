/**
 * 实时服务流 mock。数据来自 P1 fixtures；另外补两条「图片 / 语音消息」示例行，
 * 用来覆盖 WP-J #57 的缩略图与「暂不支持自动草稿」展示。
 * 列表和详情都按 docs/P1-api.md §6 的字段组织。
 */
import advisorsFixture from './fixtures/advisors.json';
import auditFixture from './fixtures/audit-events.json';
import deliveriesFixture from './fixtures/deliveries.json';
import draftsFixture from './fixtures/drafts.json';
import groupsFixture from './fixtures/groups.json';
import knowledgeFixture from './fixtures/knowledge.json';
import memoriesFixture from './fixtures/memories.json';
import patientsFixture from './fixtures/patients.json';
import verificationsFixture from './fixtures/verifications.json';
import { API_BASE, ApiError, isMockMode } from './http.ts';
import { mediaUrl, type MediaItem, type MediaKind } from './media.ts';

export type FlowStatus =
  | 'QUEUED'
  | 'PUSHED'
  | 'ACKNOWLEDGED'
  | 'VERIFIED'
  | 'EDIT_SENT'
  | 'MISROUTE_ALERT'
  | 'UNVERIFIED'
  | 'RELEASED'
  | 'DEAD_LETTER'
  | 'SKIPPED';

export type RiskLevel = 'low' | 'medium' | 'high';
export type FlowSource = 'inbound' | 'proactive';

export interface FlowDurations {
  inboundToDraftMs?: number;
  draftToPushMs?: number;
  pushToAckMs?: number;
  ackToVerifiedMs?: number;
}

export interface ServiceFlowRow {
  id: string;
  source: FlowSource;
  groupId: string;
  groupName: string;
  patientId: string;
  patientName: string;
  advisorId: string;
  advisorName: string;
  summary: string;
  riskLevel: RiskLevel;
  status: FlowStatus;
  mediaKinds: MediaKind[];
  version: number;
  fallback: boolean;
  sandbox: boolean;
  demo: boolean;
  createdAt: number;
  durations: FlowDurations;
}

export interface FlowRevision {
  version: number;
  body: string;
  instruction: string | null;
  createdBy: string;
  createdAt: number;
}

export interface FlowDraft {
  id: string;
  body: string;
  version: number;
  revisions: FlowRevision[];
  sentVersion: number | null;
  riskLevel: RiskLevel;
  status: FlowStatus;
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
}

export interface FlowDelivery {
  id: string;
  draftId?: string;
  version: number;
  msgid: string;
  roomId: string;
  text: string;
  sentAt: number;
  source: string;
  sandbox: boolean;
  createdAt: number;
}

export interface FlowVerification {
  id: string;
  draftId?: string;
  outcome: string;
  matchedMsgId: string | null;
  matchedRoomId: string | null;
  matchedGroupName: string | null;
  similarity: number | null;
  attempts: number;
  checkedAt: number;
  sandbox: boolean;
}

export interface FlowTimelineItem {
  at: number;
  type: string;
  actor: string;
  title: string;
  detail?: string;
}

export interface FlowAuditItem {
  id: string;
  action: string;
  actorName: string;
  result: string;
  at: number;
}

export interface FlowDetail {
  draft: FlowDraft;
  patient: { id: string; displayName: string };
  group: { id: string; name: string; roomId: string };
  advisor: { id: string; name: string };
  citations: {
    memories: { id: string; category: string; content: string; deletedAt: number | null }[];
    knowledge: { id: string; title: string; deletedAt: number | null }[];
  };
  deliveries: FlowDelivery[];
  verification: FlowVerification | null;
  timeline: FlowTimelineItem[];
  audit: FlowAuditItem[];
  media: MediaItem[];
  note?: string;
}

export interface ServiceFlowQuery {
  groupId?: string;
  advisorId?: string;
  patientId?: string;
  status?: FlowStatus | string;
  riskLevel?: RiskLevel | string;
  source?: FlowSource | string;
  from?: number;
  to?: number;
  page?: number;
  pageSize?: number;
}

export interface ServiceFlowList {
  items: ServiceFlowRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface DraftRaw {
  id: string;
  patientId: string;
  groupId: string;
  groupRoomId: string;
  groupName: string;
  advisorId: string;
  source: string;
  inboundSummary: string;
  body: string;
  version: number;
  revisions: FlowRevision[];
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
  lastInboundAt: number | null;
  createdAt: number;
  pushedAt: number | null;
  ackedAt: number | null;
  verifiedAt: number | null;
  verificationId: string | null;
  mediaIds: string[];
}

const drafts = draftsFixture as unknown as DraftRaw[];
const deliveries = deliveriesFixture as unknown as FlowDelivery[];
const verifications = verificationsFixture as unknown as FlowVerification[];
const memories = memoriesFixture as unknown as {
  id: string;
  category: string;
  content: string;
  deletedAt: number | null;
}[];
const knowledge = knowledgeFixture as unknown as {
  id: string;
  title: string;
  deletedAt: number | null;
}[];
const audits = auditFixture as unknown as {
  id: string;
  action: string;
  actorName: string;
  result: string;
  targetId: string | null;
  at: number;
}[];
const patients = patientsFixture as unknown as { id: string; displayName: string }[];
const groups = groupsFixture as unknown as { id: string; name: string; roomId: string }[];
const advisors = advisorsFixture as unknown as { id: string; name: string }[];

const patientMap = new Map(patients.map((item) => [item.id, item]));
const groupMap = new Map(groups.map((item) => [item.id, item]));
const advisorMap = new Map(advisors.map((item) => [item.id, item]));

/** 两条补充行：图片消息与语音消息（fixtures 里没有对应草稿，仅用于前端演示） */
const SYNTHETIC_ROWS: ServiceFlowRow[] = [
  {
    id: 'draft_1015',
    source: 'inbound',
    groupId: 'grp_06',
    groupName: '家人-吴女士',
    patientId: 'pat_05',
    patientName: '吴女士',
    advisorId: 'adv_01',
    advisorName: '李顾问',
    summary: '午餐照片：清蒸鱼和糙米饭',
    riskLevel: 'low',
    status: 'VERIFIED',
    mediaKinds: ['meal'],
    version: 1,
    fallback: false,
    sandbox: false,
    demo: false,
    createdAt: 1794208800000,
    durations: {
      inboundToDraftMs: 60000,
      draftToPushMs: 2000,
      pushToAckMs: 150000,
      ackToVerifiedMs: 180000,
    },
  },
  {
    id: 'draft_1016',
    source: 'inbound',
    groupId: 'grp_06',
    groupName: '家人-吴女士',
    patientId: 'pat_05',
    patientName: '吴女士',
    advisorId: 'adv_01',
    advisorName: '李顾问',
    summary: '一段 12 秒语音',
    riskLevel: 'low',
    status: 'SKIPPED',
    mediaKinds: ['voice'],
    version: 1,
    fallback: false,
    sandbox: false,
    demo: false,
    createdAt: 1794210600000,
    durations: { inboundToDraftMs: 0 },
  },
];

const SYNTHETIC_DRAFTS: Record<string, FlowDraft> = {
  draft_1015: {
    id: 'draft_1015',
    body: '这份午餐有清蒸鱼、糙米饭和西兰花，搭配不错。鱼的做法清淡，主食控制在小半碗，蔬菜量也够。',
    version: 1,
    revisions: [
      {
        version: 1,
        body: '这份午餐有清蒸鱼、糙米饭和西兰花，搭配不错。鱼的做法清淡，主食控制在小半碗，蔬菜量也够。',
        instruction: null,
        createdBy: 'agent',
        createdAt: 1794208860000,
      },
    ],
    sentVersion: 1,
    riskLevel: 'low',
    status: 'VERIFIED',
    ruleIds: [],
    citedMemoryIds: [],
    citedKnowledgeIds: ['knw_02'],
    fallback: false,
    sandbox: false,
    demo: false,
    cardTaskId: 'task_1015',
    pushAttempts: 1,
    verifyAttempts: 1,
    createdAt: 1794208860000,
    pushedAt: 1794208880000,
    ackedAt: 1794209030000,
    verifiedAt: 1794209210000,
    verificationId: 'vrf_15',
  },
  draft_1016: {
    id: 'draft_1016',
    body: '',
    version: 1,
    revisions: [],
    sentVersion: null,
    riskLevel: 'low',
    status: 'SKIPPED',
    ruleIds: [],
    citedMemoryIds: [],
    citedKnowledgeIds: [],
    fallback: false,
    sandbox: false,
    demo: false,
    cardTaskId: null,
    pushAttempts: 0,
    verifyAttempts: 0,
    createdAt: 1794210600000,
    pushedAt: null,
    ackedAt: null,
    verifiedAt: null,
    verificationId: null,
  },
};

function duration(start: number | null, end: number | null): number | undefined {
  if (start === null || end === null) return undefined;
  return Math.max(0, end - start);
}

function makeRow(raw: DraftRaw): ServiceFlowRow {
  const source: FlowSource = raw.source === 'proactive' ? 'proactive' : 'inbound';
  return {
    id: raw.id,
    source,
    groupId: raw.groupId,
    groupName: raw.groupName,
    patientId: raw.patientId,
    patientName: patientMap.get(raw.patientId)?.displayName ?? '未知患者',
    advisorId: raw.advisorId,
    advisorName: advisorMap.get(raw.advisorId)?.name ?? '未分配顾问',
    summary: raw.inboundSummary,
    riskLevel: raw.riskLevel as RiskLevel,
    status: raw.status as FlowStatus,
    mediaKinds: raw.mediaIds.length > 0 ? ['image'] : [],
    version: raw.version,
    fallback: raw.fallback,
    sandbox: raw.sandbox,
    demo: raw.demo,
    createdAt: raw.createdAt,
    durations: {
      inboundToDraftMs: duration(raw.lastInboundAt, raw.createdAt),
      draftToPushMs: duration(raw.createdAt, raw.pushedAt),
      pushToAckMs: duration(raw.pushedAt, raw.ackedAt),
      ackToVerifiedMs: duration(raw.ackedAt, raw.verifiedAt),
    },
  };
}

const fixtureRows = drafts.map(makeRow);

/* ----------------------------- 实时演示流 ----------------------------- */

export interface FlowEvent {
  id: string;
  type: 'draft.created' | 'draft.pushed' | 'draft.acked' | 'draft.verified';
  at: number;
  message: string;
  draftId: string;
  status: FlowStatus;
}

export type FlowStreamPayload = { event: FlowEvent; row: ServiceFlowRow | null };

let liveCounter = 0;
let currentLiveId: string | null = null;
let currentStep = 0;
const liveRows = new Map<string, ServiceFlowRow>();
const liveDetails = new Map<string, FlowDetail>();

export function resetServiceFlowMock(): void {
  liveCounter = 0;
  currentLiveId = null;
  currentStep = 0;
  liveRows.clear();
  liveDetails.clear();
}

function liveStatus(step: number): FlowStatus {
  if (step === 0) return 'QUEUED';
  if (step === 1) return 'PUSHED';
  if (step === 2) return 'ACKNOWLEDGED';
  return 'VERIFIED';
}

function buildLiveDetail(row: ServiceFlowRow, step: number): FlowDetail {
  const now = row.createdAt;
  const draft: FlowDraft = {
    id: row.id,
    body: '晚上建议清淡一点，主食选糙米或杂粮，搭配一份鱼或豆腐，再来两拳头的绿叶菜。记得避开海鲜。',
    version: 1,
    revisions: [
      {
        version: 1,
        body: '晚上建议清淡一点，主食选糙米或杂粮，搭配一份鱼或豆腐，再来两拳头的绿叶菜。记得避开海鲜。',
        instruction: null,
        createdBy: 'agent',
        createdAt: now + 60_000,
      },
    ],
    sentVersion: step >= 3 ? 1 : null,
    riskLevel: 'low',
    status: row.status,
    ruleIds: [],
    citedMemoryIds: ['mem_01', 'mem_02'],
    citedKnowledgeIds: ['knw_01', 'knw_02'],
    fallback: false,
    sandbox: false,
    demo: false,
    cardTaskId: `task_live_${liveCounter}`,
    pushAttempts: step >= 1 ? 1 : 0,
    verifyAttempts: step >= 3 ? 1 : 0,
    createdAt: now + 60_000,
    pushedAt: step >= 1 ? now + 62_000 : null,
    ackedAt: step >= 2 ? now + 122_000 : null,
    verifiedAt: step >= 3 ? now + 127_000 : null,
    verificationId: step >= 3 ? `vrf_live_${liveCounter}` : null,
  };
  const timeline: FlowTimelineItem[] = [
    {
      at: now,
      type: 'inbound',
      actor: row.patientName,
      title: '客户发来消息',
      detail: row.summary,
    },
    {
      at: draft.createdAt,
      type: 'draft',
      actor: '小安',
      title: '生成第 1 版草稿',
      detail: draft.body,
    },
  ];
  if (step >= 1) {
    timeline.push({
      at: draft.pushedAt ?? now,
      type: 'push',
      actor: 'system',
      title: '推送到顾问企微',
    });
  }
  if (step >= 2) {
    timeline.push({
      at: draft.ackedAt ?? now,
      type: 'ack',
      actor: row.advisorName,
      title: '点击已发送',
    });
  }
  if (step >= 3) {
    timeline.push({
      at: draft.verifiedAt ?? now,
      type: 'verification',
      actor: 'system',
      title: '核验通过',
    });
  }
  return {
    draft,
    patient: { id: row.patientId, displayName: row.patientName },
    group: {
      id: row.groupId,
      name: row.groupName,
      roomId: groupMap.get(row.groupId)?.roomId ?? 'wr_demo_grp_01',
    },
    advisor: { id: row.advisorId, name: row.advisorName },
    citations: {
      memories: memories
        .filter((item) => draft.citedMemoryIds.includes(item.id))
        .map(({ id, category, content, deletedAt }) => ({ id, category, content, deletedAt })),
      knowledge: knowledge
        .filter((item) => draft.citedKnowledgeIds.includes(item.id))
        .map(({ id, title, deletedAt }) => ({ id, title, deletedAt })),
    },
    deliveries:
      step >= 1
        ? [
            {
              id: `dly_live_${liveCounter}`,
              version: 1,
              msgid: `msg_live_${liveCounter}`,
              roomId: groupMap.get(row.groupId)?.roomId ?? 'wr_demo_grp_01',
              text: draft.body,
              sentAt: draft.ackedAt ?? draft.pushedAt ?? now,
              source: 'archive',
              sandbox: false,
              createdAt: draft.ackedAt ?? draft.pushedAt ?? now,
            },
          ]
        : [],
    verification:
      step >= 3
        ? {
            id: `vrf_live_${liveCounter}`,
            outcome: 'verified',
            matchedMsgId: `msg_live_${liveCounter}`,
            matchedRoomId: groupMap.get(row.groupId)?.roomId ?? 'wr_demo_grp_01',
            matchedGroupName: row.groupName,
            similarity: 1,
            attempts: 1,
            checkedAt: draft.verifiedAt ?? now,
            sandbox: false,
          }
        : null,
    timeline,
    audit: [
      {
        id: `aud_live_${liveCounter}`,
        action: 'draft.enqueue',
        actorName: 'system',
        result: 'success',
        at: draft.createdAt,
      },
    ],
    media: [],
  };
}

function emitLiveStep(): FlowStreamPayload {
  const now = Date.now();
  if (!currentLiveId || currentStep > 3) {
    liveCounter += 1;
    currentLiveId = `draft_live_${liveCounter}`;
    currentStep = 0;
  }

  const id = currentLiveId;
  const existing = liveRows.get(id);
  const row: ServiceFlowRow = existing
    ? {
        ...existing,
        status: liveStatus(currentStep),
        durations: {
          ...existing.durations,
          draftToPushMs: currentStep >= 1 ? 2_000 : undefined,
          pushToAckMs: currentStep >= 2 ? 60_000 : undefined,
          ackToVerifiedMs: currentStep >= 3 ? 5_000 : undefined,
        },
      }
    : {
        id,
        source: 'inbound',
        groupId: 'grp_01',
        groupName: '糖友-张女士',
        patientId: 'pat_01',
        patientName: '张女士',
        advisorId: 'adv_01',
        advisorName: '李顾问',
        summary: '实时演示：晚上吃点什么好',
        riskLevel: 'low',
        status: 'QUEUED',
        mediaKinds: [],
        version: 1,
        fallback: false,
        sandbox: false,
        demo: false,
        createdAt: now,
        durations: { inboundToDraftMs: 60_000 },
      };

  const type: FlowEvent['type'] =
    currentStep === 0
      ? 'draft.created'
      : currentStep === 1
        ? 'draft.pushed'
        : currentStep === 2
          ? 'draft.acked'
          : 'draft.verified';
  const message =
    currentStep === 0
      ? `新草稿已生成 · ${row.patientName}`
      : currentStep === 1
        ? `草稿已推送到 ${row.advisorName}`
        : currentStep === 2
          ? `${row.advisorName} 点击已发送`
          : '核验通过 ✅';

  liveRows.set(id, row);
  liveDetails.set(id, buildLiveDetail(row, currentStep));
  currentStep += 1;

  return {
    event: {
      id: `evt_live_${liveCounter}_${currentStep}`,
      type,
      at: now,
      message,
      draftId: id,
      status: row.status,
    },
    row,
  };
}

export function emitNextFlowEvent(): FlowStreamPayload {
  return emitLiveStep();
}

export function subscribeServiceFlow(
  handler: (payload: FlowStreamPayload) => void,
  intervalMs = 2600,
): () => void {
  if (!isMockMode) {
    const source = new EventSource(`${API_BASE}/sse/events?types=draft.*`, {
      withCredentials: true,
    });
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as FlowEvent;
        handler({ event, row: null });
      } catch {
        // 忽略无法解析的事件，断线重连后页面会重新拉一次列表
      }
    };
    return () => source.close();
  }

  const timer = window.setInterval(() => handler(emitLiveStep()), intervalMs);
  return () => window.clearInterval(timer);
}

/* ------------------------------- 查询 ------------------------------- */

function allRows(): ServiceFlowRow[] {
  return [...liveRows.values(), ...SYNTHETIC_ROWS, ...fixtureRows];
}

function matches(row: ServiceFlowRow, query: ServiceFlowQuery): boolean {
  if (query.groupId && row.groupId !== query.groupId) return false;
  if (query.advisorId && row.advisorId !== query.advisorId) return false;
  if (query.patientId && row.patientId !== query.patientId) return false;
  if (query.riskLevel && row.riskLevel !== query.riskLevel) return false;
  if (query.source && row.source !== query.source) return false;
  if (query.status) {
    const allowed = String(query.status).split(',').filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(row.status)) return false;
  }
  if (query.from && row.createdAt < query.from) return false;
  if (query.to && row.createdAt > query.to) return false;
  return true;
}

function buildQueryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function listServiceFlow(query: ServiceFlowQuery = {}): Promise<ServiceFlowList> {
  if (!isMockMode) {
    return apiGet<ServiceFlowList>(
      `/service-flow${buildQueryString({
        groupId: query.groupId,
        advisorId: query.advisorId,
        patientId: query.patientId,
        status: query.status,
        riskLevel: query.riskLevel,
        source: query.source,
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  }

  const filtered = allRows()
    .filter((row) => matches(row, query))
    .sort((a, b) => b.createdAt - a.createdAt);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: filtered.length,
  };
}

export async function getServiceFlowDetail(draftId: string): Promise<FlowDetail> {
  if (!isMockMode) {
    return apiGet<FlowDetail>(`/service-flow/${draftId}`);
  }

  const live = liveDetails.get(draftId);
  if (live) return live;

  const synthetic = SYNTHETIC_DRAFTS[draftId];
  if (synthetic) {
    const row = SYNTHETIC_ROWS.find((item) => item.id === draftId);
    if (!row) throw new ApiError('NOT_FOUND', '草稿不存在', 404);
    const media: MediaItem[] =
      row.mediaKinds.length > 0
        ? row.mediaKinds.map((kind) => ({
            id: `med_flow_${draftId}`,
            kind,
            url: mediaUrl(`med_flow_${draftId}`, kind),
            label: row.summary,
          }))
        : [];
    const timeline: FlowTimelineItem[] = [
      {
        at: row.createdAt - 60_000,
        type: 'inbound',
        actor: row.patientName,
        title: '客户发来消息',
        detail: row.summary,
      },
    ];
    if (row.status === 'SKIPPED') {
      timeline.push({
        at: row.createdAt,
        type: 'skip',
        actor: '小安',
        title: '暂不支持自动草稿',
        detail: '语音 / 文件 / 视频消息在 P1 只标记，不生成草稿。',
      });
    } else {
      timeline.push(
        {
          at: row.createdAt,
          type: 'draft',
          actor: '小安',
          title: '生成第 1 版草稿',
          detail: synthetic.body,
        },
        {
          at: row.createdAt + 2_000,
          type: 'push',
          actor: 'system',
          title: '推送到顾问企微',
        },
        {
          at: row.createdAt + 17_000,
          type: 'ack',
          actor: row.advisorName,
          title: '点击已发送',
        },
        {
          at: row.createdAt + 35_000,
          type: 'verification',
          actor: 'system',
          title: '核验通过',
        },
      );
    }
    return {
      draft: synthetic,
      patient: { id: row.patientId, displayName: row.patientName },
      group: {
        id: row.groupId,
        name: row.groupName,
        roomId: groupMap.get(row.groupId)?.roomId ?? 'wr_demo_grp_06',
      },
      advisor: { id: row.advisorId, name: row.advisorName },
      citations: {
        memories: [],
        knowledge: knowledge
          .filter((item) => synthetic.citedKnowledgeIds.includes(item.id))
          .map(({ id, title, deletedAt }) => ({ id, title, deletedAt })),
      },
      deliveries:
        row.status === 'SKIPPED'
          ? []
          : [
              {
                id: 'dly_15',
                version: 1,
                msgid: 'msg_sent_1015',
                roomId: groupMap.get(row.groupId)?.roomId ?? 'wr_demo_grp_06',
                text: synthetic.body,
                sentAt: row.createdAt + 17_000,
                source: 'archive',
                sandbox: false,
                createdAt: row.createdAt + 20_000,
              },
            ],
      verification:
        row.status === 'SKIPPED'
          ? null
          : {
              id: 'vrf_15',
              outcome: 'verified',
              matchedMsgId: 'msg_sent_1015',
              matchedRoomId: groupMap.get(row.groupId)?.roomId ?? 'wr_demo_grp_06',
              matchedGroupName: row.groupName,
              similarity: 1,
              attempts: 1,
              checkedAt: row.createdAt + 35_000,
              sandbox: false,
            },
      timeline,
      audit: [
        {
          id: 'aud_15',
          action: row.status === 'SKIPPED' ? 'draft.skip' : 'draft.verify',
          actorName: 'system',
          result: 'success',
          at: row.createdAt,
        },
      ],
      media,
      note:
        row.status === 'SKIPPED'
          ? '语音 / 文件 / 视频消息暂不支持自动草稿，P1 只做标记。'
          : undefined,
    };
  }

  const raw = drafts.find((item) => item.id === draftId);
  if (!raw) throw new ApiError('NOT_FOUND', '草稿不存在', 404);

  const patient = patientMap.get(raw.patientId);
  const group = groupMap.get(raw.groupId);
  const advisor = advisorMap.get(raw.advisorId);
  if (!patient || !group || !advisor) {
    throw new ApiError('NOT_FOUND', '关联数据缺失', 404);
  }

  const deliveryList = deliveries.filter((item) => item.draftId === draftId);
  const verification = raw.verificationId
    ? (verifications.find((item) => item.id === raw.verificationId) ?? null)
    : (verifications.find((item) => item.draftId === draftId) ?? null);

  const timeline: FlowTimelineItem[] = [];
  if (raw.source === 'proactive') {
    timeline.push({
      at: raw.lastInboundAt ?? raw.createdAt,
      type: 'proactive',
      actor: '小安',
      title: 'Agent 主动计划触发',
      detail: raw.inboundSummary,
    });
  } else {
    timeline.push({
      at: raw.lastInboundAt ?? raw.createdAt,
      type: 'inbound',
      actor: patient.displayName,
      title: '客户发来消息',
      detail: raw.inboundSummary,
    });
  }
  for (const revision of raw.revisions) {
    timeline.push({
      at: revision.createdAt,
      type: 'draft',
      actor: revision.createdBy === 'staff' ? advisor.name : '小安',
      title:
        revision.createdBy === 'staff'
          ? `顾问改稿：${revision.instruction ?? '调整措辞'}（第 ${revision.version} 版）`
          : `生成第 ${revision.version} 版草稿`,
      detail: revision.body,
    });
  }
  if (raw.pushedAt) {
    timeline.push({
      at: raw.pushedAt,
      type: 'push',
      actor: 'system',
      title: '推送到顾问企微',
    });
  }
  if (raw.ackedAt) {
    timeline.push({
      at: raw.ackedAt,
      type: 'ack',
      actor: advisor.name,
      title: raw.status === 'SKIPPED' ? '已跳过' : '点击已发送',
    });
  }
  if (raw.verifiedAt || verification) {
    timeline.push({
      at: raw.verifiedAt ?? verification?.checkedAt ?? raw.createdAt,
      type: 'verification',
      actor: 'system',
      title: verificationTitle(verification?.outcome, verification?.matchedGroupName),
    });
  }
  timeline.sort((a, b) => a.at - b.at);

  const media: MediaItem[] = raw.mediaIds.map((mediaId) => ({
    id: mediaId,
    kind: 'image',
    url: mediaUrl(mediaId, 'image'),
    label: raw.inboundSummary,
  }));

  return {
    draft: {
      id: raw.id,
      body: raw.body,
      version: raw.version,
      revisions: raw.revisions,
      sentVersion: raw.sentVersion,
      riskLevel: raw.riskLevel as RiskLevel,
      status: raw.status as FlowStatus,
      ruleIds: raw.ruleIds,
      citedMemoryIds: raw.citedMemoryIds,
      citedKnowledgeIds: raw.citedKnowledgeIds,
      fallback: raw.fallback,
      sandbox: raw.sandbox,
      demo: raw.demo,
      cardTaskId: raw.cardTaskId,
      pushAttempts: raw.pushAttempts,
      verifyAttempts: raw.verifyAttempts,
      createdAt: raw.createdAt,
      pushedAt: raw.pushedAt,
      ackedAt: raw.ackedAt,
      verifiedAt: raw.verifiedAt,
      verificationId: raw.verificationId,
    },
    patient: { id: patient.id, displayName: patient.displayName },
    group: { id: group.id, name: group.name, roomId: group.roomId },
    advisor: { id: advisor.id, name: advisor.name },
    citations: {
      memories: memories
        .filter((item) => raw.citedMemoryIds.includes(item.id))
        .map(({ id, category, content, deletedAt }) => ({ id, category, content, deletedAt })),
      knowledge: knowledge
        .filter((item) => raw.citedKnowledgeIds.includes(item.id))
        .map(({ id, title, deletedAt }) => ({ id, title, deletedAt })),
    },
    deliveries: deliveryList,
    verification,
    timeline,
    audit: audits
      .filter((item) => item.targetId === draftId)
      .map(({ id, action, actorName, result, at }) => ({ id, action, actorName, result, at })),
    media,
  };
}

function verificationTitle(outcome?: string, matchedGroupName?: string | null): string {
  if (outcome === 'verified') return '核验通过 ✅';
  if (outcome === 'edit_sent') return '改后发送 ✏️';
  if (outcome === 'misroute') return `发错群 ⚠️：实际发到「${matchedGroupName ?? '未知群'}」`;
  if (outcome === 'unverified') return '未找到实发消息 ❌';
  return '等待核验';
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new ApiError(
      error?.code || 'INTERNAL',
      error?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return payload as T;
}

export const FLOW_STATUS_META: Record<
  FlowStatus,
  { label: string; color: string; badge: 'success' | 'processing' | 'error' | 'warning' | 'default' }
> = {
  QUEUED: { label: '排队中', color: 'default', badge: 'default' },
  PUSHED: { label: '已推送', color: 'blue', badge: 'processing' },
  ACKNOWLEDGED: { label: '顾问已确认', color: 'cyan', badge: 'processing' },
  VERIFIED: { label: '✅ 已核验', color: 'green', badge: 'success' },
  EDIT_SENT: { label: '✏️ 改后发送', color: 'purple', badge: 'success' },
  MISROUTE_ALERT: { label: '⚠️ 发错群', color: 'red', badge: 'error' },
  UNVERIFIED: { label: '❌ 未核验', color: 'volcano', badge: 'error' },
  RELEASED: { label: '已释放', color: 'gold', badge: 'warning' },
  DEAD_LETTER: { label: '推送死信', color: 'magenta', badge: 'error' },
  SKIPPED: { label: '已跳过', color: 'default', badge: 'default' },
};

export const RISK_LABELS: Record<RiskLevel, { label: string; color: string }> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'gold' },
  high: { label: '高风险', color: 'red' },
};

export const SOURCE_LABELS: Record<FlowSource, string> = {
  inbound: '患者提问',
  proactive: 'Agent 主动',
};
