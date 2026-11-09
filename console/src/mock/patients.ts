import actionsFixture from './fixtures/agent-actions.json';
import advisorsFixture from './fixtures/advisors.json';
import carePlansFixture from './fixtures/care-plans.json';
import deliveriesFixture from './fixtures/deliveries.json';
import draftsFixture from './fixtures/drafts.json';
import groupsFixture from './fixtures/groups.json';
import memoriesFixture from './fixtures/memories.json';
import patientsFixture from './fixtures/patients.json';
import tenantFixture from './fixtures/tenant.json';
import verificationsFixture from './fixtures/verifications.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';

export type ConsentStatus = 'agreed' | 'unknown' | 'disagreed';
export type PatientStatus = 'serving' | 'paused' | 'archived';
export type MemoryCategory =
  | 'dietary_taboo'
  | 'routine'
  | 'goal'
  | 'body'
  | 'family'
  | 'preference'
  | 'other';
export type MemorySubject = 'self' | 'family' | 'unknown';
export type CarePlanStatus = 'pending' | 'done' | 'cancelled';
export type AgentTool =
  | 'reply_draft'
  | 'reply_skip'
  | 'memory_write'
  | 'memory_update'
  | 'schedule_create'
  | 'escalate_to_human'
  | 'meal_log_write';
export type ActionResult = 'success' | 'failed' | 'skipped';

export interface Patient {
  id: string;
  tenantId: string;
  displayName: string;
  avatar: string | null;
  externalUserId: string | null;
  tags: string[];
  advisorId: string | null;
  groupIds: string[];
  consent: ConsentStatus;
  consentCheckedAt: number | null;
  status: PatientStatus;
  demo: boolean;
  accompaniedSince: number;
  lastActiveAt: number | null;
  memoryCount: number;
  pendingPlanCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Memory {
  id: string;
  tenantId: string;
  patientId: string;
  category: MemoryCategory;
  content: string;
  subject: MemorySubject;
  sourceMsgId: string | null;
  sourceText: string | null;
  createdBy: 'agent' | 'staff';
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  deletedBy: string | null;
  sandbox: boolean;
}

export interface CarePlan {
  id: string;
  tenantId: string;
  patientId: string;
  title: string;
  when: number;
  rrule: string | null;
  source: 'agent' | 'staff';
  status: CarePlanStatus;
  quietHoursShifted: boolean;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
  sandbox: boolean;
}

export interface AgentAction {
  id: string;
  tenantId: string;
  patientId: string;
  draftId: string | null;
  tool: AgentTool;
  summary: string;
  result: ActionResult;
  errorCode: string | null;
  createdAt: number;
  sandbox: boolean;
}

export interface TimelineEvent {
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

export interface HealthProfile {
  patientId: string;
  heightCm: number;
  weightKg: number;
  bmi: number;
  bloodPressure: string;
  conditions: string[];
  medications: string[];
  updatedAt: number;
  sample: true;
}

export interface ServicePlanSample {
  patientId: string;
  planName: string;
  startedAt: number;
  endsAt: number;
  goals: string[];
  sessions: { at: number; title: string }[];
  sample: true;
}

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  dietary_taboo: '饮食禁忌 / 过敏',
  routine: '作息',
  goal: '健康目标',
  body: '身体状况',
  family: '家庭情况',
  preference: '偏好',
  other: '其他',
};

export const MEMORY_SUBJECT_LABELS: Record<MemorySubject, string> = {
  self: '本人',
  family: '家属',
  unknown: '未确定',
};

export const CONSENT_LABELS: Record<ConsentStatus, string> = {
  agreed: '已同意存档',
  unknown: '待确认同意',
  disagreed: '不同意存档',
};

export const PATIENT_STATUS_LABELS: Record<PatientStatus, string> = {
  serving: '服务中',
  paused: '已暂停',
  archived: '已归档',
};

export const CARE_PLAN_STATUS_LABELS: Record<CarePlanStatus, string> = {
  pending: '待执行',
  done: '已执行',
  cancelled: '已取消',
};

export const AGENT_TOOL_LABELS: Record<AgentTool, string> = {
  reply_draft: '生成回复草稿',
  reply_skip: '跳过回复',
  memory_write: '写入记忆',
  memory_update: '更新记忆',
  schedule_create: '创建计划',
  escalate_to_human: '升级人工',
  meal_log_write: '记录餐食',
};

export const ACTION_RESULT_LABELS: Record<ActionResult, string> = {
  success: '成功',
  failed: '失败',
  skipped: '跳过',
};

export interface PatientListQuery {
  q?: string;
  tag?: string;
  advisorId?: string;
  status?: PatientStatus | '';
  page?: number;
  pageSize?: number;
}

export interface PatientListResult {
  items: Patient[];
  page: number;
  pageSize: number;
  total: number;
}

interface PatientsState {
  patients: Patient[];
  memories: Memory[];
  carePlans: CarePlan[];
  actions: AgentAction[];
}

const STATE_KEY = 'zhiban.console.k.patients';
const tenant = tenantFixture as unknown as { id: string; agentName: string };
const advisors = advisorsFixture as unknown as { id: string; name: string }[];
const groups = groupsFixture as unknown as {
  id: string;
  name: string;
  status: string;
  roomId: string;
}[];

let cachedState: PatientsState | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seedState(): PatientsState {
  return {
    patients: clone(patientsFixture) as unknown as Patient[],
    memories: clone(memoriesFixture) as unknown as Memory[],
    carePlans: clone(carePlansFixture) as unknown as CarePlan[],
    actions: clone(actionsFixture) as unknown as AgentAction[],
  };
}

function readState(): PatientsState {
  if (cachedState) return cachedState;
  try {
    const raw = localStorage.getItem(STATE_KEY);
    cachedState = raw ? (JSON.parse(raw) as PatientsState) : seedState();
  } catch {
    // 隐私模式或存储被禁用时，本次会话使用内存状态
    cachedState = seedState();
  }
  return cachedState;
}

function writeState(state: PatientsState): void {
  cachedState = state;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 同上
  }
}

/** 仅供测试：清除本地改动并恢复到 fixtures。 */
export function resetPatientsMock(): void {
  cachedState = null;
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    // 同上
  }
}

function now(): number {
  return Date.now();
}

function advisorName(advisorId: string | null): string {
  if (!advisorId) return '未分配';
  return advisors.find((item) => item.id === advisorId)?.name ?? '未分配';
}

function findPatient(patientId: string): Patient {
  const patient = readState().patients.find(
    (item) => item.id === patientId && item.deletedAt === null,
  );
  if (!patient) throw new ApiError('NOT_FOUND', '患者不存在或已删除', 404);
  return patient;
}

function recount(state: PatientsState, patientId: string): void {
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return;
  patient.memoryCount = state.memories.filter(
    (item) => item.patientId === patientId && item.deletedAt === null,
  ).length;
  patient.pendingPlanCount = state.carePlans.filter(
    (item) => item.patientId === patientId && item.status === 'pending',
  ).length;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export async function listPatients(query: PatientListQuery = {}): Promise<PatientListResult> {
  if (!isMockMode) {
    return apiRequest<PatientListResult>(`/patients${buildQuery({ ...query })}`);
  }

  const state = readState();
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const keyword = query.q?.trim().toLowerCase() ?? '';

  const filtered = state.patients
    .filter((item) => item.deletedAt === null)
    .filter((item) => (query.status ? item.status === query.status : true))
    .filter((item) => (query.tag ? item.tags.includes(query.tag) : true))
    .filter((item) => (query.advisorId ? item.advisorId === query.advisorId : true))
    .filter((item) =>
      keyword
        ? item.displayName.toLowerCase().includes(keyword) ||
          item.tags.some((tag) => tag.toLowerCase().includes(keyword))
        : true,
    )
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));

  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: filtered.length,
  };
}

export function availableTags(): string[] {
  const tags = new Set<string>();
  for (const patient of readState().patients) {
    if (patient.deletedAt !== null) continue;
    for (const tag of patient.tags) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export interface PatientDetail {
  patient: Patient;
  advisor: { id: string; name: string; status: string; online: boolean } | null;
  groups: { id: string; name: string; status: string; isPrimary: boolean }[];
}

export async function getPatientDetail(patientId: string): Promise<PatientDetail> {
  if (!isMockMode) return apiRequest<PatientDetail>(`/patients/${patientId}`);

  const patient = findPatient(patientId);
  const advisor = advisors.find((item) => item.id === patient.advisorId) as
    | { id: string; name: string; status?: string; online?: boolean }
    | undefined;
  const boundGroups = patient.groupIds
    .map((groupId) => groups.find((item) => item.id === groupId))
    .filter((item): item is (typeof groups)[number] => Boolean(item))
    .map((group, index) => ({
      id: group.id,
      name: group.name,
      status: group.status,
      isPrimary: index === 0,
    }));

  return {
    patient,
    advisor: advisor
      ? {
          id: advisor.id,
          name: advisor.name,
          status: advisor.status ?? 'active',
          online: Boolean(advisor.online),
        }
      : null,
    groups: boundGroups,
  };
}

export async function updatePatient(
  patientId: string,
  patch: { displayName?: string; tags?: string[]; consent?: ConsentStatus; status?: PatientStatus },
): Promise<Patient> {
  if (!isMockMode) {
    return apiRequest<Patient>(`/patients/${patientId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  const state = readState();
  const patient = findPatient(patientId);
  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim();
    if (!name) throw new ApiError('VALIDATION_FAILED', '备注名不能为空', 422);
    patient.displayName = name;
  }
  if (patch.tags) patient.tags = patch.tags;
  if (patch.consent) patient.consent = patch.consent;
  if (patch.status) patient.status = patch.status;
  patient.updatedAt = now();
  writeState(state);
  return patient;
}

/** 群绑定变更后同步患者的 groupIds（由 groups mock 调用）。 */
export function attachPatientToGroup(patientId: string, groupId: string): void {
  const state = readState();
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return;
  if (!patient.groupIds.includes(groupId)) {
    patient.groupIds = [...patient.groupIds, groupId];
    patient.updatedAt = now();
    writeState(state);
  }
}

export function detachPatientFromGroup(patientId: string, groupId: string): void {
  const state = readState();
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return;
  patient.groupIds = patient.groupIds.filter((item) => item !== groupId);
  patient.updatedAt = now();
  writeState(state);
}

/** 在群页面「绑定新患者」时创建患者。 */
export async function createPatient(input: {
  displayName: string;
  tags?: string[];
  consent?: ConsentStatus;
}): Promise<Patient> {
  if (!isMockMode) {
    return apiRequest<Patient>('/patients', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  const name = input.displayName.trim();
  if (!name) throw new ApiError('VALIDATION_FAILED', '患者备注名不能为空', 422);

  const state = readState();
  const timestamp = now();
  const patient: Patient = {
    id: `pat_mock_${timestamp}`,
    tenantId: tenant.id,
    displayName: name,
    avatar: null,
    externalUserId: null,
    tags: input.tags ?? [],
    advisorId: null,
    groupIds: [],
    consent: input.consent ?? 'unknown',
    consentCheckedAt: null,
    status: 'serving',
    demo: false,
    accompaniedSince: timestamp,
    lastActiveAt: null,
    memoryCount: 0,
    pendingPlanCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  state.patients.push(patient);
  writeState(state);
  return patient;
}

export async function listMemories(
  patientId: string,
  category?: MemoryCategory | '',
): Promise<Memory[]> {
  if (!isMockMode) {
    return apiRequest<{ items: Memory[] }>(
      `/patients/${patientId}/memories${buildQuery({ category })}`,
    ).then((result) => result.items);
  }

  findPatient(patientId);
  return readState()
    .memories.filter(
      (item) => item.patientId === patientId && item.deletedAt === null,
    )
    .filter((item) => (category ? item.category === category : true))
    .sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return b.createdAt - a.createdAt;
    });
}

export async function updateMemory(
  memoryId: string,
  patch: { category?: MemoryCategory; content?: string; subject?: MemorySubject },
): Promise<Memory> {
  if (!isMockMode) {
    return apiRequest<Memory>(`/memories/${memoryId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  const state = readState();
  const memory = state.memories.find((item) => item.id === memoryId && item.deletedAt === null);
  if (!memory) throw new ApiError('NOT_FOUND', '记忆不存在或已删除', 404);

  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content) throw new ApiError('VALIDATION_FAILED', '记忆内容不能为空', 422);
    if (content.length > 200) throw new ApiError('VALIDATION_FAILED', '记忆内容不能超过 200 字', 422);
    memory.content = content;
  }
  if (patch.category) memory.category = patch.category;
  if (patch.subject) memory.subject = patch.subject;
  memory.updatedAt = now();
  writeState(state);
  return memory;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  if (!isMockMode) {
    await apiRequest<void>(`/memories/${memoryId}`, { method: 'DELETE' });
    return;
  }

  const state = readState();
  const memory = state.memories.find((item) => item.id === memoryId && item.deletedAt === null);
  if (!memory) throw new ApiError('NOT_FOUND', '记忆不存在或已删除', 404);

  memory.deletedAt = now();
  memory.deletedBy = null;
  memory.updatedAt = memory.deletedAt;
  recount(state, memory.patientId);
  writeState(state);
}

export async function listCarePlans(
  patientId: string,
  status?: CarePlanStatus | '',
): Promise<CarePlan[]> {
  if (!isMockMode) {
    return apiRequest<{ items: CarePlan[] }>(
      `/patients/${patientId}/care-plans${buildQuery({ status })}`,
    ).then((result) => result.items);
  }

  findPatient(patientId);
  return readState()
    .carePlans.filter((item) => item.patientId === patientId)
    .filter((item) => (status ? item.status === status : true))
    .sort((a, b) => a.when - b.when);
}

export async function createCarePlan(
  patientId: string,
  input: { title: string; when: number },
): Promise<CarePlan> {
  if (!isMockMode) {
    return apiRequest<CarePlan>(`/patients/${patientId}/care-plans`, {
      method: 'POST',
      body: JSON.stringify({ ...input, source: 'staff' }),
    });
  }

  const title = input.title.trim();
  if (!title) throw new ApiError('VALIDATION_FAILED', '计划内容不能为空', 422);
  if (!Number.isFinite(input.when)) throw new ApiError('VALIDATION_FAILED', '请选择执行时间', 422);
  if (input.when < now()) throw new ApiError('VALIDATION_FAILED', '执行时间不能早于当前时间', 422);

  const state = readState();
  findPatient(patientId);
  const timestamp = now();
  const plan: CarePlan = {
    id: `pln_mock_${timestamp}`,
    tenantId: tenant.id,
    patientId,
    title,
    when: input.when,
    rrule: null,
    source: 'staff',
    status: 'pending',
    quietHoursShifted: false,
    lastFiredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    sandbox: false,
  };
  state.carePlans.push(plan);
  recount(state, patientId);
  writeState(state);
  return plan;
}

export async function cancelCarePlan(planId: string): Promise<CarePlan> {
  if (!isMockMode) {
    return apiRequest<CarePlan>(`/care-plans/${planId}/cancel`, { method: 'POST' });
  }

  const state = readState();
  const plan = state.carePlans.find((item) => item.id === planId);
  if (!plan) throw new ApiError('NOT_FOUND', '计划不存在', 404);
  if (plan.status === 'done') throw new ApiError('IMMUTABLE_RESOURCE', '已执行的计划不能取消', 409);
  if (plan.status === 'pending') {
    plan.status = 'cancelled';
    plan.updatedAt = now();
    recount(state, plan.patientId);
    writeState(state);
  }
  return plan;
}

export async function listActions(patientId: string): Promise<AgentAction[]> {
  if (!isMockMode) {
    return apiRequest<{ items: AgentAction[] }>(`/patients/${patientId}/actions`).then(
      (result) => result.items,
    );
  }

  findPatient(patientId);
  return readState()
    .actions.filter((item) => item.patientId === patientId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

const VERIFICATION_TITLES: Record<TimelineEvent['verificationOutcome'] & string, string> = {
  verified: '核验通过',
  edit_sent: '改稿后发送',
  misroute: '发错群',
  unverified: '未核验',
};

interface DraftFixture {
  id: string;
  patientId: string;
  advisorId: string | null;
  inboundSummary: string | null;
  body: string;
  version: number;
  revisions: { version: number; body: string; createdBy: string; createdAt: number }[];
  lastInboundAt: number | null;
  createdAt: number;
}

interface DeliveryFixture {
  id: string;
  draftId: string;
  version: number;
  advisorId: string | null;
  text: string;
  sentAt: number;
}

interface VerificationFixture {
  id: string;
  draftId: string;
  outcome: NonNullable<TimelineEvent['verificationOutcome']>;
  matchedGroupName: string | null;
  similarity: number | null;
  checkedAt: number;
}

/** 用 drafts / deliveries / verifications 拼出患者时间线（mock）。 */
export function buildTimeline(patientId: string): TimelineEvent[] {
  const patient = findPatient(patientId);
  const drafts = (draftsFixture as unknown as DraftFixture[]).filter(
    (item) => item.patientId === patientId,
  );
  const deliveries = deliveriesFixture as unknown as DeliveryFixture[];
  const verifications = verificationsFixture as unknown as VerificationFixture[];
  const events: TimelineEvent[] = [];

  for (const draft of drafts) {
    if (draft.lastInboundAt && draft.inboundSummary) {
      events.push({
        id: `evt_${draft.id}_inbound`,
        at: draft.lastInboundAt,
        type: 'inbound',
        actor: { type: 'patient', name: patient.displayName },
        title: '客户发来消息',
        detail: draft.inboundSummary,
        draftId: draft.id,
        verificationOutcome: null,
      });
    }

    if (draft.revisions.length > 0) {
      for (const revision of draft.revisions) {
        const first = revision.version === 1;
        events.push({
          id: `evt_${draft.id}_v${revision.version}`,
          at: revision.createdAt,
          type: first ? 'draft' : 'revision',
          actor: first
            ? { type: 'agent', name: tenant.agentName }
            : { type: 'advisor', name: advisorName(draft.advisorId) },
          title: first ? '生成第 1 版草稿' : `顾问修改第 ${revision.version} 版`,
          detail: revision.body,
          draftId: draft.id,
          verificationOutcome: null,
        });
      }
    } else {
      events.push({
        id: `evt_${draft.id}_v1`,
        at: draft.createdAt,
        type: 'draft',
        actor: { type: 'agent', name: tenant.agentName },
        title: '生成第 1 版草稿',
        detail: draft.body,
        draftId: draft.id,
        verificationOutcome: null,
      });
    }

    for (const delivery of deliveries.filter((item) => item.draftId === draft.id)) {
      events.push({
        id: `evt_${delivery.id}`,
        at: delivery.sentAt,
        type: 'delivery',
        actor: { type: 'advisor', name: advisorName(delivery.advisorId) },
        title: `已发送第 ${delivery.version} 版`,
        detail: delivery.text,
        draftId: draft.id,
        verificationOutcome: null,
      });
    }

    for (const verification of verifications.filter((item) => item.draftId === draft.id)) {
      const detail =
        verification.outcome === 'misroute' && verification.matchedGroupName
          ? `实际发到了「${verification.matchedGroupName}」`
          : verification.similarity !== null
            ? `相似度 ${Math.round(verification.similarity * 100)}%`
            : null;
      events.push({
        id: `evt_${verification.id}`,
        at: verification.checkedAt,
        type: 'verification',
        actor: { type: 'system', name: 'system' },
        title: VERIFICATION_TITLES[verification.outcome],
        detail,
        draftId: draft.id,
        verificationOutcome: verification.outcome,
      });
    }
  }

  return events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export async function getTimeline(patientId: string): Promise<TimelineEvent[]> {
  if (!isMockMode) {
    return apiRequest<{ items: TimelineEvent[] }>(`/patients/${patientId}/timeline`).then(
      (result) => result.items,
    );
  }
  return buildTimeline(patientId);
}

export async function getHealthProfile(patientId: string): Promise<HealthProfile> {
  if (!isMockMode) {
    return apiRequest<HealthProfile>(`/patients/${patientId}/health-profile`);
  }

  const patient = findPatient(patientId);
  const index = readState().patients.findIndex((item) => item.id === patientId);
  const heightCm = 158 + (index % 6) * 3;
  const weightKg = 55 + (index % 5) * 4;
  const bmi = Number((weightKg / (heightCm / 100) ** 2).toFixed(1));

  return {
    patientId,
    heightCm,
    weightKg,
    bmi,
    bloodPressure: index % 2 === 0 ? '128/82' : '135/88',
    conditions: patient.tags.length > 0 ? patient.tags : ['暂无记录'],
    medications: index % 2 === 0 ? ['示例药物 A（每日一次）'] : ['示例药物 B（随餐）'],
    updatedAt: patient.updatedAt,
    sample: true,
  };
}

export async function getServicePlan(patientId: string): Promise<ServicePlanSample> {
  if (!isMockMode) {
    return apiRequest<ServicePlanSample>(`/patients/${patientId}/service-plan`);
  }

  const patient = findPatient(patientId);
  const start = patient.accompaniedSince;
  return {
    patientId,
    planName: '90 天代谢管理计划（示例）',
    startedAt: start,
    endsAt: start + 90 * 86_400_000,
    goals: ['餐后血糖稳定在 8 以下', '每周 3 次快走，每次 30 分钟'],
    sessions: [
      { at: start, title: '首次评估与目标确认' },
      { at: start + 14 * 86_400_000, title: '第 2 周复盘' },
      { at: start + 45 * 86_400_000, title: '中期调整' },
      { at: start + 90 * 86_400_000, title: '结项评估' },
    ],
    sample: true,
  };
}
