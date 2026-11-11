import bindingsFixture from './fixtures/group-bindings.json';
import groupsFixture from './fixtures/groups.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';
import {
  attachPatientToGroup,
  createPatient,
  getPatientDetail,
  listGroupMembers,
  listPatients,
  setPatientIdentity,
  type ConsentStatus,
  type Patient,
} from './patients.ts';

export type GroupStatus = 'pending' | 'serving' | 'collect_only' | 'disabled';

export interface Group {
  id: string;
  tenantId: string;
  roomId: string;
  chatId: string | null;
  name: string;
  nameSource: 'config' | 'api' | 'members' | 'roomid' | 'manual';
  status: GroupStatus;
  advisorId: string | null;
  patientIds: string[];
  memberCount: number;
  externalMemberCount: number;
  consent: { agreed: number; unknown: number; disagreed: number };
  lastActiveAt: number | null;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface GroupBinding {
  id: string;
  tenantId: string;
  groupId: string;
  patientId: string;
  isPrimary: boolean;
  createdAt: number;
  deletedAt: number | null;
}

export const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  pending: '待确认',
  serving: '服务中',
  collect_only: '仅采集',
  disabled: '停用',
};

export const GROUP_STATUS_COLORS: Record<GroupStatus, string> = {
  pending: 'gold',
  serving: 'green',
  collect_only: 'blue',
  disabled: 'default',
};

export interface GroupListQuery {
  status?: GroupStatus | '';
  advisorId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface GroupListResult {
  items: Group[];
  page: number;
  pageSize: number;
  total: number;
}

interface GroupsState {
  groups: Group[];
  bindings: GroupBinding[];
}

const STATE_KEY = 'zhiban.console.k.groups';
let cachedState: GroupsState | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seedState(): GroupsState {
  return {
    groups: clone(groupsFixture) as unknown as Group[],
    bindings: clone(bindingsFixture) as unknown as GroupBinding[],
  };
}

function readState(): GroupsState {
  if (cachedState) return cachedState;
  try {
    const raw = localStorage.getItem(STATE_KEY);
    cachedState = raw ? (JSON.parse(raw) as GroupsState) : seedState();
  } catch {
    cachedState = seedState();
  }
  return cachedState;
}

function writeState(state: GroupsState): void {
  cachedState = state;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式或存储被禁用时使用内存状态
  }
}

/** 仅供测试：清除本地改动并恢复到 fixtures。 */
export function resetGroupsMock(): void {
  cachedState = null;
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    // 同上
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export async function listGroups(query: GroupListQuery = {}): Promise<GroupListResult> {
  if (!isMockMode) {
    return apiRequest<GroupListResult>(`/groups${buildQuery({ ...query })}`);
  }

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const keyword = query.q?.trim().toLowerCase() ?? '';

  const filtered = readState()
    .groups.filter((item) => item.deletedAt === null)
    .filter((item) => (query.status ? item.status === query.status : true))
    .filter((item) => (query.advisorId ? item.advisorId === query.advisorId : true))
    .filter((item) => (keyword ? item.name.toLowerCase().includes(keyword) : true))
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));

  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: filtered.length,
  };
}

export async function updateGroup(
  groupId: string,
  patch: { name?: string; status?: GroupStatus; advisorId?: string | null },
): Promise<Group> {
  if (!isMockMode) {
    return apiRequest<Group>(`/groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  const state = readState();
  const group = state.groups.find((item) => item.id === groupId && item.deletedAt === null);
  if (!group) throw new ApiError('NOT_FOUND', '群不存在', 404);

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ApiError('VALIDATION_FAILED', '群名不能为空', 422);
    group.name = name;
    // 手工改名优先，企微群名同步不再覆盖
    group.nameSource = 'manual';
  }
  if (patch.status) group.status = patch.status;
  if (patch.advisorId !== undefined) group.advisorId = patch.advisorId || null;
  group.updatedAt = Date.now();
  writeState(state);
  return group;
}

export async function bindPatient(
  groupId: string,
  input: { patientId: string } | { newPatient: { displayName: string; tags?: string[]; consent?: ConsentStatus } },
): Promise<{ binding: GroupBinding; patient: Patient }> {
  if (!isMockMode) {
    return apiRequest<{ binding: GroupBinding; patient: Patient }>(
      `/groups/${groupId}/bindings`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  const state = readState();
  const group = state.groups.find((item) => item.id === groupId && item.deletedAt === null);
  if (!group) throw new ApiError('NOT_FOUND', '群不存在', 404);

  if ('patientId' in input) {
    const { patient } = await getPatientDetail(input.patientId);
    return addBinding(state, group, patient);
  }
  const patient = await createPatient(input.newPatient);
  return addBinding(state, group, patient);
}

/**
 * 从群成员选服务对象：同一 externalUserId 已有患者时复用，否则新建再绑定。
 * 与后端 POST /groups/{id}/bindings { memberId } 语义一致。
 */
export async function bindGroupMember(
  groupId: string,
  memberId: string,
): Promise<{ binding: GroupBinding; patient: Patient }> {
  if (!isMockMode) {
    return apiRequest<{ binding: GroupBinding; patient: Patient }>(
      `/groups/${groupId}/bindings`,
      { method: 'POST', body: JSON.stringify({ memberId }) },
    );
  }

  const member = (await listGroupMembers(groupId)).find((item) => item.id === memberId);
  if (!member) throw new ApiError('VALIDATION_FAILED', '群成员不存在', 422);
  if (!member.isExternal || !member.externalUserId) {
    throw new ApiError('VALIDATION_FAILED', '只能选择外部成员作为服务对象', 422);
  }

  const state = readState();
  const group = state.groups.find((item) => item.id === groupId && item.deletedAt === null);
  if (!group) throw new ApiError('NOT_FOUND', '群不存在', 404);

  const existing = (await listPatients({ pageSize: 200 })).items.find(
    (item) => item.externalUserId === member.externalUserId,
  );
  let patient =
    existing ??
    (await createPatient({
      displayName: member.displayName,
      consent: member.consent,
    }));

  const bound = state.bindings.find(
    (item) =>
      item.groupId === group.id && item.patientId === patient.id && item.deletedAt === null,
  );
  const binding = bound ?? addBinding(state, group, patient).binding;

  // 患者身份指向所选成员（role=self、同意状态跟随）
  patient = await setPatientIdentity(patient.id, {
    groupId,
    externalUserId: member.externalUserId,
    displayName: member.displayName,
  });

  return { binding, patient };
}

function addBinding(
  state: GroupsState,
  group: Group,
  patient: Patient,
): { binding: GroupBinding; patient: Patient } {
  const duplicated = state.bindings.some(
    (item) =>
      item.groupId === group.id && item.patientId === patient.id && item.deletedAt === null,
  );
  if (duplicated) throw new ApiError('CONFLICT', '该群已绑定这位患者', 409);

  const timestamp = Date.now();
  const binding: GroupBinding = {
    id: `gbd_mock_${timestamp}`,
    tenantId: group.tenantId,
    groupId: group.id,
    patientId: patient.id,
    isPrimary: group.patientIds.length === 0,
    createdAt: timestamp,
    deletedAt: null,
  };
  state.bindings.push(binding);
  group.patientIds = [...group.patientIds, patient.id];
  group.updatedAt = timestamp;
  writeState(state);
  attachPatientToGroup(patient.id, group.id);

  return { binding, patient };
}

export function pendingGroupCount(): number {
  return readState().groups.filter(
    (item) => item.deletedAt === null && item.status === 'pending',
  ).length;
}
