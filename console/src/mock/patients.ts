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
export type IdentityStatus = 'pending' | 'confirmed';
export type IdentitySource = 'auto' | 'manual';
export type MemberRole = 'self' | 'family' | 'advisor' | 'colleague' | 'unknown';
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
  /** 患者身份确认状态：pending=系统按发言推测待确认；confirmed=顾问手动指定 */
  identityStatus?: IdentityStatus;
  /** 身份来源：auto=按发言自动推测；manual=顾问在控制台确认/改绑 */
  identitySource?: IdentitySource;
  identityConfirmedAt?: number | null;
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

/** 服务群成员：用于「设为当前 Agent 的患者」选择 */
export interface PatientGroupMember {
  id: string;
  groupId: string;
  externalUserId: string | null;
  externalUserIdTail: string | null;
  displayName: string;
  isExternal: boolean;
  staffUserId?: string | null;
  role: MemberRole;
  consent: ConsentStatus;
  lastActiveAt?: number | null;
  annotatedBy?: string | null;
  annotatedAt?: number | null;
}

export interface SetPatientIdentityInput {
  groupId: string;
  externalUserId: string;
  displayName?: string;
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
  /** 内容/分类/归属被真正修正的时间；只更新来源时不设置 */
  revisedAt?: number | null;
  updatedBy?: 'agent' | 'staff' | null;
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

/** 慢病管理：与后端 src/p1/chronic.ts 保持同一套字段与枚举 */
export const CHRONIC_CONDITION_PRESETS = [
  '高血压',
  '2 型糖尿病',
  '1 型糖尿病',
  '高脂血症',
  '冠心病',
  '慢性心力衰竭',
  '慢性肾脏病',
  '慢性阻塞性肺疾病',
  '哮喘',
  '痛风',
  '高尿酸血症',
  '脂肪肝',
  '骨质疏松',
  '甲状腺功能异常',
  '脑卒中后遗症',
  '类风湿关节炎',
  '慢性胃炎',
] as const;

export interface ChronicMetricSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  dual?: { label: string; min: number; max: number };
  contexts?: readonly string[];
}

export const CHRONIC_METRICS = {
  bp: { label: '血压', unit: 'mmHg', min: 50, max: 260, dual: { label: '舒张压', min: 30, max: 180 } },
  glucose: { label: '血糖', unit: 'mmol/L', min: 1, max: 40, contexts: ['空腹', '餐后 2 小时', '随机', '睡前'] },
  hba1c: { label: '糖化血红蛋白', unit: '%', min: 3, max: 20 },
  weight: { label: '体重', unit: 'kg', min: 20, max: 250 },
  heart_rate: { label: '心率', unit: '次/分', min: 30, max: 220 },
  uric_acid: { label: '血尿酸', unit: 'μmol/L', min: 50, max: 1200 },
  ldl: { label: '低密度脂蛋白', unit: 'mmol/L', min: 0.2, max: 15 },
} as const;

export type ChronicMetric = keyof typeof CHRONIC_METRICS;
export type ChronicSource = 'advisor' | 'agent';

export const CHRONIC_SOURCE_LABELS: Record<ChronicSource, string> = {
  advisor: '顾问录入',
  agent: '对话提取',
};

export interface ChronicMeasurement {
  id: string;
  metric: ChronicMetric;
  value: number;
  secondaryValue?: number;
  context?: string;
  measuredAt: number;
  source: ChronicSource;
  recordedAt: number;
  recordedBy?: string;
}

export interface ChronicMedication {
  name: string;
  dose?: string;
  frequency?: string;
  note?: string;
  source: ChronicSource;
  updatedAt: number;
  updatedBy?: string;
}

export interface ChronicProfile {
  patientId: string;
  tenantId: string;
  conditions: string[];
  heightCm?: number;
  weightKg?: number;
  medications: ChronicMedication[];
  measurements: ChronicMeasurement[];
  notes?: string;
  updatedAt: number;
  updatedBy?: string;
}

export interface ChronicMeasurementInput {
  metric: ChronicMetric;
  value: number;
  secondaryValue?: number;
  context?: string;
  measuredAt?: number;
}

export interface ChronicMedicationInput {
  name: string;
  dose?: string;
  frequency?: string;
  note?: string;
}

export interface ChronicProfilePatch {
  conditions?: string[];
  heightCm?: number | null;
  weightKg?: number | null;
  medications?: ChronicMedicationInput[];
  notes?: string | null;
  measurements?: ChronicMeasurementInput[];
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
  unknown: '存档待确认',
  disagreed: '不同意存档',
};

export const CONSENT_HINTS: Record<ConsentStatus, string> = {
  agreed: '已确认该成员同意企微会话存档。',
  unknown: '尚未确认该成员是否同意企微会话存档；系统会提示顾问人工留意。',
  disagreed: '该成员不同意会话存档，系统不会自动生成服务草稿。',
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
  members: PatientGroupMember[];
  /** 慢病档案：patientId → profile；旧缓存缺省时按需生成 */
  chronicProfiles?: Record<string, ChronicProfile>;
}

const STATE_KEY = 'zhiban.console.k.patients';
const tenant = tenantFixture as unknown as { id: string; agentName: string };
const advisors = advisorsFixture as unknown as { id: string; name: string }[];
const groups = groupsFixture as unknown as {
  id: string;
  name: string;
  status: string;
  roomId: string;
  advisorId?: string;
  memberCount?: number;
  externalMemberCount?: number;
}[];

let cachedState: PatientsState | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 演示成员：每位患者一个「本人」+ 一位家属 + 群顾问。仅 mock 模式使用。 */
function seedMembers(patients: Patient[]): PatientGroupMember[] {
  const members: PatientGroupMember[] = [];
  for (const patient of patients) {
    for (const groupId of patient.groupIds) {
      const group = groups.find((item) => item.id === groupId);
      if (!group) continue;
      const externalUserId = patient.externalUserId ?? `wm_demo_${patient.id}`;
      members.push({
        id: `gm_self_${groupId}`,
        groupId,
        externalUserId,
        externalUserIdTail: externalUserId.slice(-6),
        displayName: patient.displayName,
        isExternal: true,
        role: 'self',
        consent: patient.consent,
        lastActiveAt: patient.lastActiveAt,
        annotatedBy: null,
        annotatedAt: null,
      });
      members.push({
        id: `gm_family_${groupId}`,
        groupId,
        externalUserId: `wm_demo_family_${groupId}`,
        externalUserIdTail: `family_${groupId.slice(-3)}`.slice(-6),
        displayName: `${patient.displayName}的家属`,
        isExternal: true,
        role: 'family',
        consent: 'unknown',
        lastActiveAt: null,
        annotatedBy: null,
        annotatedAt: null,
      });
      if (group.advisorId) {
        const advisor = advisors.find((item) => item.id === group.advisorId);
        members.push({
          id: `gm_advisor_${groupId}`,
          groupId,
          externalUserId: null,
          externalUserIdTail: null,
          displayName: advisor?.name ?? '顾问',
          isExternal: false,
          staffUserId: group.advisorId,
          role: 'advisor',
          consent: 'agreed',
          lastActiveAt: null,
          annotatedBy: null,
          annotatedAt: null,
        });
      }
    }
  }
  // 待确认群的成员还没同步到患者域；给有外部成员的群补一个占位成员，
  // 让「开始服务」可以选服务对象。真实模式由群成员同步提供。
  for (const group of groups) {
    if (!group.externalMemberCount) continue;
    if (members.some((member) => member.groupId === group.id)) continue;
    const externalUserId = `wm_demo_external_${group.id}`;
    members.push({
      id: `gm_external_${group.id}`,
      groupId: group.id,
      externalUserId,
      externalUserIdTail: externalUserId.slice(-6),
      displayName: `外部成员 ${externalUserId.slice(-4)}`,
      isExternal: true,
      role: 'self',
      consent: 'unknown',
      lastActiveAt: null,
      annotatedBy: null,
      annotatedAt: null,
    });
  }
  return members;
}

function seedState(): PatientsState {
  const patients = clone(patientsFixture) as unknown as Patient[];
  return {
    patients,
    memories: clone(memoriesFixture) as unknown as Memory[],
    carePlans: clone(carePlansFixture) as unknown as CarePlan[],
    actions: clone(actionsFixture) as unknown as AgentAction[],
    members: seedMembers(patients),
  };
}

/** 旧缓存可能没有 members 表；缺失时按现有患者补一次。 */
function ensureMembers(state: PatientsState): PatientGroupMember[] {
  if (!Array.isArray(state.members)) state.members = seedMembers(state.patients);
  return state.members;
}

function ensureChronicProfiles(state: PatientsState): Record<string, ChronicProfile> {
  if (!state.chronicProfiles || typeof state.chronicProfiles !== 'object') {
    state.chronicProfiles = {};
  }
  return state.chronicProfiles;
}

/** 演示档案：用患者标签做慢病标签，并给几条虚构体征，便于看清布局 */
function seedChronicProfile(patient: Patient): ChronicProfile {
  const now = Date.now();
  const day = 86_400_000;
  const heightCm = 158 + (patient.id.length % 6) * 3;
  const weightKg = 55 + (patient.id.length % 5) * 4;
  return {
    patientId: patient.id,
    tenantId: patient.tenantId,
    conditions: patient.tags.length > 0 ? [...patient.tags] : ['高血压'],
    heightCm,
    weightKg,
    medications: [
      {
        name: '示例降压药',
        dose: '5 mg',
        frequency: '每日一次',
        note: '虚构示例，仅用于展示',
        source: 'advisor',
        updatedAt: now - 3 * day,
        updatedBy: '李顾问',
      },
    ],
    measurements: [
      {
        id: `cme_demo_${patient.id}_1`,
        metric: 'bp',
        value: 128,
        secondaryValue: 82,
        measuredAt: now - day,
        source: 'advisor',
        recordedAt: now - day,
        recordedBy: '李顾问',
      },
      {
        id: `cme_demo_${patient.id}_2`,
        metric: 'glucose',
        value: 6.4,
        context: '空腹',
        measuredAt: now - 2 * day,
        source: 'agent',
        recordedAt: now - 2 * day,
        recordedBy: 'Agent',
      },
      {
        id: `cme_demo_${patient.id}_3`,
        metric: 'hba1c',
        value: 6.8,
        measuredAt: now - 30 * day,
        source: 'advisor',
        recordedAt: now - 30 * day,
        recordedBy: '李顾问',
      },
    ],
    notes: '示例档案：演示慢病标签、体征与用药的结构化展示。',
    updatedAt: now - day,
    updatedBy: '李顾问',
  };
}

function ensureChronicProfile(state: PatientsState, patientId: string): ChronicProfile | undefined {
  const profiles = ensureChronicProfiles(state);
  const existing = profiles[patientId];
  if (existing) return existing;
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return undefined;
  const profile = seedChronicProfile(patient);
  profiles[patientId] = profile;
  return profile;
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
  ensureMembers(cachedState);
  ensureChronicProfiles(cachedState);
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

/** 服务群成员列表（含角色/同意），用于「设为患者」选择。 */
export async function listGroupMembers(groupId: string): Promise<PatientGroupMember[]> {
  if (!isMockMode) {
    const data = await apiRequest<{ items: PatientGroupMember[]; total: number }>(
      `/groups/${groupId}/members`,
    );
    return data.items;
  }
  const state = readState();
  return ensureMembers(state)
    .filter((member) => member.groupId === groupId)
    .map((member) => ({ ...member }));
}

/** 确认 / 改绑患者身份：把患者指向服务群里的某位外部成员。 */
export async function setPatientIdentity(
  patientId: string,
  input: SetPatientIdentityInput,
): Promise<Patient> {
  if (!isMockMode) {
    return apiRequest<Patient>(`/patients/${patientId}/identity`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  const state = readState();
  const patient = findPatient(patientId);
  if (!patient.groupIds.includes(input.groupId)) {
    throw new ApiError('VALIDATION_FAILED', '患者未绑定该服务群', 422);
  }
  const members = ensureMembers(state);
  const member = members.find(
    (item) => item.groupId === input.groupId && item.externalUserId === input.externalUserId,
  );
  if (!member || !member.isExternal) {
    throw new ApiError('VALIDATION_FAILED', '该成员不是服务群的外部成员', 422);
  }

  const previous = patient.externalUserId;
  patient.externalUserId = input.externalUserId;
  const rename = input.displayName?.trim();
  if (previous !== input.externalUserId || !patient.displayName) {
    patient.displayName = rename || member.displayName;
  } else if (rename) {
    patient.displayName = rename;
  }
  patient.consent = member.consent;
  patient.identityStatus = 'confirmed';
  patient.identitySource = 'manual';
  patient.identityConfirmedAt = now();
  patient.updatedAt = now();

  // 被选成员标为「本人」，原「本人」成员降为「家属」
  for (const item of members) {
    if (item.groupId !== input.groupId) continue;
    if (item.externalUserId === input.externalUserId) {
      item.role = 'self';
      item.annotatedBy = 'console';
      item.annotatedAt = now();
    } else if (previous && item.externalUserId === previous && item.role === 'self') {
      item.role = 'family';
      item.annotatedBy = 'console';
      item.annotatedAt = now();
    }
  }

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

  const before = {
    category: memory.category,
    content: memory.content,
    subject: memory.subject,
  };
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content) throw new ApiError('VALIDATION_FAILED', '记忆内容不能为空', 422);
    if (content.length > 200) throw new ApiError('VALIDATION_FAILED', '记忆内容不能超过 200 字', 422);
    memory.content = content;
  }
  if (patch.category) memory.category = patch.category;
  if (patch.subject) memory.subject = patch.subject;
  const at = now();
  memory.updatedAt = at;
  const corrected =
    memory.category !== before.category ||
    memory.content !== before.content ||
    memory.subject !== before.subject;
  if (corrected) {
    memory.revisedAt = at;
    memory.updatedBy = 'staff';
  }
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

  // 与真实接口一致：最新事件在前，分页第一页永远是最新的一段。
  return events.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

export interface TimelinePage {
  items: TimelineEvent[];
  page: number;
  pageSize: number;
  total: number;
}

export async function getTimeline(
  patientId: string,
  page = 1,
  pageSize = 20,
): Promise<TimelinePage> {
  if (!isMockMode) {
    const query = `?page=${page}&pageSize=${pageSize}`;
    return apiRequest<TimelinePage>(`/patients/${patientId}/timeline${query}`);
  }
  const events = buildTimeline(patientId);
  const start = (Math.max(1, page) - 1) * pageSize;
  return {
    items: events.slice(start, start + pageSize),
    page,
    pageSize,
    total: events.length,
  };
}

export function chronicMetricSpec(metric: ChronicMetric): ChronicMetricSpec {
  return CHRONIC_METRICS[metric];
}

export function formatChronicValue(input: {
  metric: ChronicMetric;
  value: number;
  secondaryValue?: number;
}): string {
  const spec = chronicMetricSpec(input.metric);
  if (spec.dual) {
    return `${input.value}/${input.secondaryValue ?? '—'} ${spec.unit}`;
  }
  return `${input.value} ${spec.unit}`;
}

function validateMockMeasurements(
  inputs: ChronicMeasurementInput[],
  now: number,
): ChronicMeasurementInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('至少提供一条体征');
  if (inputs.length > 5) throw new Error('一次最多录入 5 条体征');
  return inputs.map((input) => {
    const spec = chronicMetricSpec(input.metric);
    if (!spec) throw new Error('体征指标无效');
    if (!Number.isFinite(input.value) || input.value < spec.min || input.value > spec.max) {
      throw new Error(`${spec.label}需在 ${spec.min}–${spec.max} ${spec.unit} 之间`);
    }
    if (spec.dual) {
      if (input.secondaryValue === undefined) throw new Error('血压需要填写舒张压');
      if (
        !Number.isFinite(input.secondaryValue) ||
        input.secondaryValue < spec.dual.min ||
        input.secondaryValue > spec.dual.max
      ) {
        throw new Error(`舒张压需在 ${spec.dual.min}–${spec.dual.max} mmHg 之间`);
      }
      if (input.secondaryValue >= input.value) throw new Error('舒张压必须小于收缩压');
    }
    if (input.measuredAt !== undefined && input.measuredAt > now + 5 * 60_000) {
      throw new Error('测量时间不能晚于当前时间');
    }
    return input;
  });
}

export async function getChronicProfile(patientId: string): Promise<ChronicProfile> {
  if (!isMockMode) {
    const response = await apiRequest<{ profile: ChronicProfile }>(
      `/patients/${patientId}/chronic-profile`,
    );
    return response.profile;
  }
  const state = readState();
  const profile = ensureChronicProfile(state, patientId);
  if (!profile) throw new Error('患者不存在');
  return clone(profile);
}

export async function updateChronicProfile(
  patientId: string,
  patch: ChronicProfilePatch,
): Promise<ChronicProfile> {
  if (!isMockMode) {
    const response = await apiRequest<{ profile: ChronicProfile }>(
      `/patients/${patientId}/chronic-profile`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return response.profile;
  }
  const state = readState();
  const existing = ensureChronicProfile(state, patientId);
  if (!existing) throw new Error('患者不存在');
  const now = Date.now();
  const next: ChronicProfile = {
    ...existing,
    conditions: [...existing.conditions],
    medications: [...existing.medications],
    measurements: [...existing.measurements],
  };
  if (patch.conditions !== undefined) {
    next.conditions = patch.conditions.map((item) => item.trim()).filter(Boolean).slice(0, 30);
  }
  if (patch.heightCm !== undefined) {
    if (patch.heightCm === null) delete next.heightCm;
    else if (patch.heightCm < 80 || patch.heightCm > 250) throw new Error('身高需在 80–250 cm 之间');
    else next.heightCm = patch.heightCm;
  }
  if (patch.weightKg !== undefined) {
    if (patch.weightKg === null) delete next.weightKg;
    else if (patch.weightKg < 20 || patch.weightKg > 250) throw new Error('体重需在 20–250 kg 之间');
    else next.weightKg = patch.weightKg;
  }
  if (patch.notes !== undefined) {
    if (patch.notes === null) delete next.notes;
    else next.notes = patch.notes.trim().slice(0, 500);
  }
  if (patch.medications !== undefined) {
    next.medications = patch.medications.map((item) => ({
      name: item.name.trim(),
      ...(item.dose ? { dose: item.dose } : {}),
      ...(item.frequency ? { frequency: item.frequency } : {}),
      ...(item.note ? { note: item.note } : {}),
      source: 'advisor' as const,
      updatedAt: now,
      updatedBy: '当前账号',
    }));
  }
  if (patch.measurements !== undefined) {
    const checked = validateMockMeasurements(patch.measurements, now);
    const added = checked.map((input, index) => ({
      id: `cme_${now}_${index}`,
      metric: input.metric,
      value: input.value,
      ...(input.secondaryValue !== undefined ? { secondaryValue: input.secondaryValue } : {}),
      ...(input.context ? { context: input.context } : {}),
      measuredAt: input.measuredAt ?? now,
      source: 'advisor' as const,
      recordedAt: now,
      recordedBy: '当前账号',
    }));
    next.measurements = [...added, ...next.measurements]
      .sort((a, b) => b.measuredAt - a.measuredAt || b.recordedAt - a.recordedAt)
      .slice(0, 500);
  }
  next.updatedAt = now;
  next.updatedBy = '当前账号';
  const profiles = ensureChronicProfiles(state);
  profiles[patientId] = next;
  writeState(state);
  return clone(next);
}

export async function getServicePlan(patientId: string): Promise<ServicePlanSample> {
  if (!isMockMode) {
    const response = await apiRequest<{ plan: ServicePlanSample | null; sample: boolean }>(
      `/patients/${patientId}/service-plan`,
    );
    if (!response.plan) throw new Error('暂无服务计划：真实计划数据尚未接入（P1）');
    return response.plan;
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
