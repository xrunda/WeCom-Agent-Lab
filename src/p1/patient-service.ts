/**
 * zhiban-patient 的业务核心（#33）。
 *
 * 只依赖同步的患者域 Store 与 Clock，脱离 DSH 也能单测。
 * 路由判定的唯一入口是 isServiceable(roomId, senderId)：
 *   serving      → 触发 Agent 回合
 *   collect_only → 只把消息写进患者会话作为上下文
 *   pending / disabled → 不处理
 * senderId 在 P1 不参与判定，但签名保留，二期按成员级服务权限扩展。
 */
import type { Clock } from '../c2/ports.ts';
import { tailId } from '../c2/redact.ts';
import { MemoryPatientStore } from './patient-store.ts';
import type {
  AdvisorRecord,
  ConsentStatus,
  GroupBinding,
  GroupMember,
  GroupNameSource,
  GroupServiceStatus,
  InboundMessage,
  ManagedGroup,
  MemberRole,
  Patient,
  RouteDecision,
  ServiceLevel,
  Speaker,
} from './types.ts';

export interface ObservedMember {
  id: string;
  isExternal: boolean;
  displayName?: string;
  lastActiveAt?: number;
}

/**
 * 是否是系统生成的占位名（存档没有昵称时用 id 尾号）。
 * 只有占位名允许被真实群昵称回填，员工手工改过的名字不动。
 */
function isFallbackDisplayName(name: string, externalUserId: string): boolean {
  const tail = tailId(externalUserId);
  return name === `外部成员 ${tail}` || name === `外部客户 ${tail}`;
}

export interface PatientServiceOptions {
  tenantId: string;
  /** 默认 false：unknown 允许服务并提示；disagreed 永远不自动服务 */
  requireConsentForTurn?: boolean;
  demo?: boolean;
}

export interface CreatePatientInput {
  displayName: string;
  externalUserId?: string;
  tags?: string[];
  advisorId?: string;
  demo?: boolean;
  consent?: ConsentStatus;
  identityStatus?: 'pending' | 'confirmed';
  identitySource?: 'auto' | 'manual';
  identityConfirmedAt?: number;
}

export class PatientService {
  readonly store: MemoryPatientStore;
  readonly clock: Clock;
  readonly tenantId: string;
  readonly requireConsentForTurn: boolean;
  readonly demo: boolean;

  constructor(store: MemoryPatientStore, clock: Clock, options: PatientServiceOptions) {
    this.store = store;
    this.clock = clock;
    this.tenantId = options.tenantId;
    this.requireConsentForTurn = options.requireConsentForTurn === true;
    this.demo = options.demo === true;
  }

  // ---------- 群自动发现 ----------

  /**
   * 存档里出现带外部成员的 roomid 就登记为 pending。
   * 已有群只刷新成员与活跃时间，不覆盖管理员改过的状态/群名。
   */
  observeGroup(
    roomId: string,
    members: ObservedMember[],
    options: {
      groupName?: string;
      groupNameSource?: GroupNameSource;
      /** 整群 userid → 昵称；用于更新没在本轮发言的成员并回填患者 */
      memberNames?: Record<string, string>;
    } = {},
  ): ManagedGroup {
    const now = this.clock.now();
    let group = this.store.getGroupByRoomId(roomId);
    if (!group) {
      group = {
        id: this.store.nextId('grp'),
        tenantId: this.tenantId,
        roomId,
        name: options.groupName ?? `群 ${tailId(roomId)}`,
        nameSource: options.groupName ? (options.groupNameSource ?? 'config') : 'roomid',
        status: 'pending',
        memberCount: 0,
        externalMemberCount: 0,
        demo: this.demo,
        createdAt: now,
        updatedAt: now,
      };
      this.store.appendAudit?.({
        at: now,
        actor: 'pipeline',
        action: 'group.discover',
        target: group.id,
        result: 'ok',
      });
    }

    let externalCount = 0;
    for (const observed of members) {
      if (observed.isExternal) externalCount += 1;
      this.upsertMember(group, observed, now);
      if (observed.isExternal && observed.displayName) {
        this.backfillPatientName(group.id, observed, now);
      }
    }
    if (options.memberNames) {
      this.applyMemberNames(group, options.memberNames, now);
    }

    group.memberCount = members.length;
    group.externalMemberCount = externalCount;
    group.lastActiveAt = Math.max(
      group.lastActiveAt ?? 0,
      ...members.map((m) => m.lastActiveAt ?? 0),
    );
    group.updatedAt = now;
    this.store.saveGroup(group);
    return group;
  }

  private upsertMember(group: ManagedGroup, observed: ObservedMember, now: number): void {
    const existing = observed.isExternal
      ? this.store.findMember(group.id, observed.id)
      : this.store
          .listMembers(group.id)
          .find((m) => !m.isExternal && m.staffUserId === observed.id);
    if (existing) {
      existing.lastActiveAt = observed.lastActiveAt ?? existing.lastActiveAt;
      if (observed.displayName) existing.displayName = observed.displayName;
      this.store.saveMember(existing);
      return;
    }

    const advisor = observed.isExternal ? undefined : this.store.getAdvisorByWecomUserId(observed.id);
    const member: GroupMember = {
      id: this.store.nextId('gm'),
      tenantId: this.tenantId,
      groupId: group.id,
      externalUserId: observed.isExternal ? observed.id : undefined,
      externalUserIdTail: observed.isExternal ? tailId(observed.id) : undefined,
      displayName:
        observed.displayName ?? (observed.isExternal ? `外部成员 ${tailId(observed.id)}` : observed.id),
      isExternal: observed.isExternal,
      staffUserId: observed.isExternal ? undefined : observed.id,
      role: observed.isExternal ? 'unknown' : advisor ? 'advisor' : 'colleague',
      consent: observed.isExternal ? 'unknown' : 'agreed',
      lastActiveAt: observed.lastActiveAt,
    };
    this.store.saveMember(member);
  }

  /**
   * 客户联系 API 拿到的真实昵称补到存量患者上。
   * 只替换系统占位名「外部成员 …尾号」；员工改过名（或患者绑定的是别人）时不覆盖。
   */
  private backfillPatientName(groupId: string, observed: ObservedMember, now: number): void {
    if (!observed.displayName) return;
    const patient = this.patientForGroup(groupId);
    if (!patient || patient.externalUserId !== observed.id) return;
    if (!isFallbackDisplayName(patient.displayName, observed.id)) return;
    if (observed.displayName === patient.displayName) return;
    patient.displayName = observed.displayName;
    patient.updatedAt = now;
    this.store.savePatient(patient);
  }

  /**
   * 整群昵称映射落到已有成员上。
   * 群成员是 API 返回的全部成员，因此本轮没发言的成员也能改名；
   * 患者仍只回填占位名，手工名不动。
   */
  private applyMemberNames(
    group: ManagedGroup,
    names: Record<string, string>,
    now: number,
  ): void {
    for (const member of this.store.listMembers(group.id)) {
      if (!member.isExternal || !member.externalUserId) continue;
      const name = names[member.externalUserId];
      if (!name || member.displayName === name) continue;
      member.displayName = name;
      this.store.saveMember(member);
    }
    for (const binding of this.store.listBindingsByGroup(group.id)) {
      const patient = this.store.getPatient(binding.patientId);
      if (!patient || patient.deletedAt !== undefined) continue;
      const externalUserId = patient.externalUserId;
      if (!externalUserId) continue;
      const name = names[externalUserId];
      if (!name || !isFallbackDisplayName(patient.displayName, externalUserId)) continue;
      patient.displayName = name;
      patient.updatedAt = now;
      this.store.savePatient(patient);
    }
  }

  // ---------- 服务状态 ----------

  isServiceable(roomId: string, _senderId: string): ServiceLevel {
    const group = this.store.getGroupByRoomId(roomId);
    if (!group || group.deletedAt !== undefined) return 'none';
    switch (group.status) {
      case 'serving':
        return 'serve';
      case 'collect_only':
        return 'collect_only';
      default:
        return 'none';
    }
  }

  /** 控制台群列表：不含已软删除的群 */
  listGroups(): ManagedGroup[] {
    return this.store.listGroups().filter((group) => group.deletedAt === undefined);
  }

  findGroup(groupId: string): ManagedGroup | undefined {
    const group = this.store.getGroup(groupId);
    return group && group.deletedAt === undefined ? group : undefined;
  }

  setGroupStatus(groupId: string, status: GroupServiceStatus): ManagedGroup {
    const group = this.requireGroup(groupId);
    group.status = status;
    group.updatedAt = this.clock.now();
    this.store.saveGroup(group);
    this.audit('admin', 'group.status', group.id, status);
    return group;
  }

  /**
   * 控制台群设置：名称 / 服务状态 / 顾问。
   * 先统一校验，再依次写入；任一项不合法时不产生任何修改。
   */
  updateGroup(
    groupId: string,
    patch: { name?: string; status?: GroupServiceStatus; advisorId?: string },
  ): ManagedGroup {
    const existing = this.requireGroup(groupId);
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new Error('EMPTY_GROUP_NAME');
    }
    if (patch.advisorId !== undefined && !this.store.getAdvisor(patch.advisorId)) {
      throw new Error(`ADVISOR_NOT_FOUND ${patch.advisorId}`);
    }
    let group = existing;
    if (patch.name !== undefined) group = this.renameGroup(group.id, patch.name);
    if (patch.status !== undefined) group = this.setGroupStatus(group.id, patch.status);
    if (patch.advisorId !== undefined) group = this.setGroupAdvisor(group.id, patch.advisorId);
    return group;
  }

  renameGroup(groupId: string, name: string): ManagedGroup {
    const group = this.requireGroup(groupId);
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error('EMPTY_GROUP_NAME');
    group.name = trimmed;
    group.nameSource = 'config';
    group.updatedAt = this.clock.now();
    this.store.saveGroup(group);
    this.audit('admin', 'group.rename', group.id, 'ok');
    return group;
  }

  setGroupAdvisor(groupId: string, advisorId: string): ManagedGroup {
    const group = this.requireGroup(groupId);
    if (!this.store.getAdvisor(advisorId)) throw new Error(`ADVISOR_NOT_FOUND ${advisorId}`);
    group.advisorId = advisorId;
    group.updatedAt = this.clock.now();
    this.store.saveGroup(group);
    this.audit('admin', 'group.advisor', group.id, advisorId);
    return group;
  }

  // ---------- 患者 ----------

  createPatient(input: CreatePatientInput): Patient {
    const now = this.clock.now();
    const patient: Patient = {
      id: this.store.nextId('pat'),
      tenantId: this.tenantId,
      displayName: input.displayName.trim() || '未命名患者',
      externalUserId: input.externalUserId,
      identityStatus: input.identityStatus,
      identitySource: input.identitySource,
      identityConfirmedAt: input.identityConfirmedAt,
      tags: input.tags ?? [],
      advisorId: input.advisorId,
      consent: input.consent ?? 'unknown',
      status: 'serving',
      demo: input.demo ?? this.demo,
      accompaniedSince: now,
      createdAt: now,
      updatedAt: now,
    };
    this.store.savePatient(patient);
    this.audit('admin', 'patient.create', patient.id, 'ok');
    return patient;
  }

  updatePatient(
    patientId: string,
    patch: Partial<
      Pick<
        Patient,
        'displayName' | 'avatar' | 'tags' | 'advisorId' | 'consent' | 'status' | 'externalUserId'
      >
    >,
  ): Patient {
    const patient = this.requirePatient(patientId);
    Object.assign(patient, patch);
    patient.updatedAt = this.clock.now();
    this.store.savePatient(patient);
    this.audit('admin', 'patient.update', patient.id, 'ok');
    return patient;
  }

  deletePatient(patientId: string): Patient {
    const patient = this.requirePatient(patientId);
    patient.deletedAt = this.clock.now();
    patient.status = 'archived';
    patient.updatedAt = this.clock.now();
    this.store.savePatient(patient);
    this.audit('admin', 'patient.delete', patient.id, 'ok');
    return patient;
  }

  bindPatient(groupId: string, patientId: string, isPrimary = false): GroupBinding {
    const group = this.requireGroup(groupId);
    this.requirePatient(patientId);
    const existing = this.store
      .listBindingsByGroup(group.id)
      .find((binding) => binding.patientId === patientId);
    if (existing) return existing;

    if (isPrimary) {
      for (const binding of this.store.listBindingsByGroup(group.id)) {
        binding.isPrimary = false;
        this.store.saveBinding(binding);
      }
    }
    const binding: GroupBinding = {
      id: this.store.nextId('gbd'),
      tenantId: this.tenantId,
      groupId: group.id,
      patientId,
      isPrimary,
      createdAt: this.clock.now(),
    };
    this.store.saveBinding(binding);
    this.audit('admin', 'group.bind', group.id, patientId);
    return binding;
  }

  unbindPatient(groupId: string, patientId: string): void {
    for (const binding of this.store.listBindingsByGroup(groupId)) {
      if (binding.patientId !== patientId) continue;
      binding.deletedAt = this.clock.now();
      this.store.saveBinding(binding);
      this.audit('admin', 'group.unbind', groupId, patientId);
    }
  }

  groupIdsFor(patientId: string): string[] {
    return this.store.listBindingsByPatient(patientId).map((binding) => binding.groupId);
  }

  patientForGroup(groupId: string): Patient | undefined {
    const bindings = this.store.listBindingsByGroup(groupId).sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    for (const binding of bindings) {
      const patient = this.store.getPatient(binding.patientId);
      if (patient && patient.deletedAt === undefined) return patient;
    }
    return undefined;
  }

  // ---------- 成员标注与同意 ----------

  annotateMember(groupId: string, memberId: string, role: MemberRole): GroupMember {
    const member = this.requireMember(groupId, memberId);
    if (!member.isExternal) {
      throw new Error('STAFF_ROLE_READONLY');
    }
    if (role !== 'self' && role !== 'family' && role !== 'unknown') {
      throw new Error(`INVALID_MEMBER_ROLE ${role}`);
    }
    member.role = role;
    member.annotatedBy = 'console';
    member.annotatedAt = this.clock.now();
    this.store.saveMember(member);

    if (role === 'self') {
      const patient = this.patientForGroup(groupId);
      if (patient && !patient.externalUserId) {
        const now = this.clock.now();
        patient.externalUserId = member.externalUserId;
        patient.displayName = member.displayName;
        patient.consent = member.consent;
        patient.identityStatus = 'confirmed';
        patient.identitySource = 'manual';
        patient.identityConfirmedAt = now;
        patient.updatedAt = now;
        this.store.savePatient(patient);
      }
    }
    this.audit('console', 'group.member.annotate', member.id, role);
    return member;
  }

  setMemberConsent(groupId: string, externalUserId: string, consent: ConsentStatus): GroupMember {
    const member = this.store.findMember(groupId, externalUserId);
    if (!member) throw new Error(`MEMBER_NOT_FOUND ${externalUserId}`);
    member.consent = consent;
    this.store.saveMember(member);
    this.refreshPatientConsent(groupId);
    this.audit('admin', 'group.member.consent', member.id, consent);
    return member;
  }

  /** check_room_agree 定时刷新入口；接口不可用时由控制台手工调用 */
  refreshConsent(groupId: string, statuses: Record<string, ConsentStatus>): void {
    for (const member of this.store.listMembers(groupId)) {
      if (!member.isExternal || member.externalUserId === undefined) continue;
      const status = statuses[member.externalUserId];
      if (status === undefined) continue;
      member.consent = status;
      this.store.saveMember(member);
    }
    this.refreshPatientConsent(groupId);
  }

  refreshPatientConsent(groupId: string): Patient | undefined {
    const patient = this.patientForGroup(groupId);
    if (!patient) return undefined;
    const members = this.store
      .listMembers(groupId)
      .filter((member) => member.isExternal && member.externalUserId !== undefined);
    const primary =
      members.find((member) => member.externalUserId === patient.externalUserId) ??
      members.find((member) => member.role === 'self') ??
      members[0];
    if (!primary) return patient;
    patient.consent = primary.consent;
    patient.consentCheckedAt = this.clock.now();
    patient.updatedAt = this.clock.now();
    this.store.savePatient(patient);
    return patient;
  }

  /**
   * 确认 / 改绑患者身份：把患者的企微身份指向服务群里的某位外部成员。
   * - 患者姓名跟随新成员（可显式覆盖），同意状态取该成员的；
   * - 被选中的成员标为「本人」，原「本人」成员降为「家属」；
   * - 审计只记录 id 尾号，不记录昵称。
   */
  setPatientIdentity(
    groupId: string,
    patientId: string,
    externalUserId: string,
    opts: { displayName?: string } = {},
  ): Patient {
    const group = this.requireGroup(groupId);
    const binding = this.store
      .listBindingsByGroup(groupId)
      .find((item) => item.patientId === patientId && item.deletedAt === undefined);
    if (!binding) throw new Error(`NOT_BOUND ${patientId} ${groupId}`);

    const member = this.store.findMember(groupId, externalUserId);
    if (!member || !member.isExternal || !member.externalUserId) {
      throw new Error(`MEMBER_NOT_EXTERNAL ${externalUserId}`);
    }

    const patient = this.requirePatient(patientId);
    const now = this.clock.now();
    const previous = patient.externalUserId;
    const changed = previous !== externalUserId;

    patient.externalUserId = externalUserId;
    const rename = opts.displayName?.trim();
    if (changed || !patient.displayName) {
      patient.displayName = rename || member.displayName;
    } else if (rename) {
      patient.displayName = rename;
    }
    patient.consent = member.consent;
    patient.identityStatus = 'confirmed';
    patient.identitySource = 'manual';
    patient.identityConfirmedAt = now;
    patient.updatedAt = now;
    this.store.savePatient(patient);

    if (member.role !== 'self') {
      member.role = 'self';
      member.annotatedBy = 'console';
      member.annotatedAt = now;
      this.store.saveMember(member);
    }
    if (changed && previous) {
      const oldMember = this.store.findMember(groupId, previous);
      if (oldMember && oldMember.role === 'self') {
        oldMember.role = 'family';
        oldMember.annotatedBy = 'console';
        oldMember.annotatedAt = now;
        this.store.saveMember(oldMember);
      }
    }

    this.audit('console', 'patient.identity', patientId, `changed ${tailId(previous)}→${tailId(externalUserId)}`);
    return patient;
  }

  consentNotice(patient: Patient): string | undefined {
    return patient.consent === 'agreed'
      ? undefined
      : `该成员未同意存档，需人工服务${patient.consent === 'unknown' ? '（状态待确认）' : ''}`;
  }

  // ---------- 路由 ----------

  /**
   * 单条消息的路由判定。合并窗口在 PatientAgentRuntime 里，
   * 这里只回答「这条消息属于谁、该不该触发回合」。
   */
  routeInbound(message: InboundMessage): RouteDecision {
    const group = this.store.getGroupByRoomId(message.roomId);
    if (!group || group.deletedAt !== undefined) {
      return { action: 'ignore', reason: 'GROUP_UNKNOWN' };
    }
    const level = this.isServiceable(message.roomId, message.from);
    if (level === 'none') {
      return { action: 'ignore', reason: `GROUP_${group.status.toUpperCase()}`, groupId: group.id };
    }

    const speaker = this.resolveSpeaker(group, message.from);
    if (!speaker.isExternal) {
      return {
        action: 'context',
        reason: 'INTERNAL_STAFF',
        groupId: group.id,
        patientId: (this.patientForGroup(group.id) ?? this.ensurePatientForGroup(group, speaker))?.id,
      };
    }

    const patient = this.ensurePatientForGroup(group, speaker);
    if (!patient) {
      return { action: 'ignore', reason: 'PATIENT_UNRESOLVED', groupId: group.id };
    }

    const consentNotice = this.consentNotice(patient);
    if (patient.consent === 'disagreed' || (this.requireConsentForTurn && patient.consent !== 'agreed')) {
      return {
        action: 'ignore',
        reason: 'CONSENT_MISSING',
        groupId: group.id,
        patientId: patient.id,
        consentNotice,
      };
    }

    patient.lastActiveAt = message.msgtime;
    patient.updatedAt = this.clock.now();
    this.store.savePatient(patient);

    if (level === 'collect_only') {
      return {
        action: 'context',
        reason: 'COLLECT_ONLY',
        groupId: group.id,
        patientId: patient.id,
        consentNotice,
      };
    }

    return {
      action: 'turn',
      reason: 'SERVING',
      groupId: group.id,
      patientId: patient.id,
      consentNotice,
    };
  }

  resolveSpeaker(group: ManagedGroup, senderId: string): Speaker {
    if (senderId.startsWith('wm')) {
      const member = this.store.findMember(group.id, senderId);
      return {
        id: senderId,
        displayName: member?.displayName ?? `外部成员 ${tailId(senderId)}`,
        role: member?.role ?? 'unknown',
        isExternal: true,
      };
    }
    const advisor = this.store.getAdvisorByWecomUserId(senderId);
    return {
      id: senderId,
      displayName: advisor?.name ?? senderId,
      role: advisor ? 'advisor' : 'colleague',
      isExternal: false,
    };
  }

  /**
   * 服务群尚未绑定患者时建档并绑定：
   * - 外部成员发言：以发言人为患者，身份待确认（除非已标注「本人」）；
   * - 内部员工先发言：用群里第一个外部成员建档（仍是猜测，身份待确认），
   *   避免上下文无处可写；顾问应在控制台确认/改绑真实患者。
   */
  ensurePatientForGroup(group: ManagedGroup, speaker: Speaker): Patient | undefined {
    const bound = this.patientForGroup(group.id);
    if (bound) {
      if (!bound.externalUserId && speaker.isExternal && speaker.role === 'self') {
        const now = this.clock.now();
        bound.externalUserId = speaker.id;
        bound.displayName = speaker.displayName;
        bound.consent = this.store.findMember(group.id, speaker.id)?.consent ?? 'unknown';
        bound.identityStatus = 'confirmed';
        bound.identitySource = 'manual';
        bound.identityConfirmedAt = now;
        bound.updatedAt = now;
      }
      return bound;
    }

    if (speaker.isExternal) {
      const member = this.store.findMember(group.id, speaker.id);
      const confirmed = member?.role === 'self';
      const now = this.clock.now();
      const patient = this.createPatient({
        displayName: speaker.displayName,
        externalUserId: speaker.id,
        advisorId: group.advisorId,
        consent: member?.consent ?? 'unknown',
        demo: group.demo,
        identityStatus: confirmed ? 'confirmed' : 'pending',
        identitySource: confirmed ? 'manual' : 'auto',
        identityConfirmedAt: confirmed ? now : undefined,
      });
      this.bindPatient(group.id, patient.id, true);
      return patient;
    }

    const source = this.store
      .listMembers(group.id)
      .find((member) => member.isExternal && member.externalUserId !== undefined);
    if (!source || !source.externalUserId) return undefined;

    const patient = this.createPatient({
      displayName: source.displayName,
      externalUserId: source.externalUserId,
      advisorId: group.advisorId,
      consent: source.consent,
      demo: group.demo,
      identityStatus: 'pending',
      identitySource: 'auto',
    });
    this.bindPatient(group.id, patient.id, true);
    return patient;
  }

  // ---------- 顾问表 ----------

  upsertAdvisor(input: {
    id?: string;
    wecomUserId: string;
    name: string;
    status?: AdvisorRecord['status'];
    seatExpireAt?: number;
    chatBound?: boolean;
  }): AdvisorRecord {
    const existing = input.id
      ? this.store.getAdvisor(input.id)
      : this.store.getAdvisorByWecomUserId(input.wecomUserId);
    const now = this.clock.now();
    if (existing) {
      existing.wecomUserId = input.wecomUserId;
      existing.name = input.name;
      existing.status = input.status ?? existing.status;
      existing.seatExpireAt = input.seatExpireAt ?? existing.seatExpireAt;
      existing.chatBound = input.chatBound ?? existing.chatBound;
      existing.updatedAt = now;
      this.store.saveAdvisor(existing);
      return existing;
    }
    const advisor: AdvisorRecord = {
      id: input.id ?? this.store.nextId('adv'),
      tenantId: this.tenantId,
      wecomUserId: input.wecomUserId,
      name: input.name,
      status: input.status ?? 'active',
      seatExpireAt: input.seatExpireAt,
      chatBound: input.chatBound ?? false,
      consecutiveMisroutes: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveAdvisor(advisor);
    return advisor;
  }

  updateAdvisor(
    advisorId: string,
    patch: Partial<Pick<AdvisorRecord, 'name' | 'status' | 'seatExpireAt' | 'chatBound'>>,
  ): AdvisorRecord {
    const advisor = this.store.getAdvisor(advisorId);
    if (!advisor) throw new Error(`ADVISOR_NOT_FOUND ${advisorId}`);
    Object.assign(advisor, patch);
    advisor.updatedAt = this.clock.now();
    this.store.saveAdvisor(advisor);
    return advisor;
  }

  // ---------- 内部 ----------

  private requireGroup(groupId: string): ManagedGroup {
    const group = this.store.getGroup(groupId);
    if (!group || group.deletedAt !== undefined) throw new Error(`GROUP_NOT_FOUND ${groupId}`);
    return group;
  }

  private requirePatient(patientId: string): Patient {
    const patient = this.store.getPatient(patientId);
    if (!patient || patient.deletedAt !== undefined) throw new Error(`PATIENT_NOT_FOUND ${patientId}`);
    return patient;
  }

  private requireMember(groupId: string, memberId: string): GroupMember {
    const member = this.store.getMember(memberId);
    if (!member || member.groupId !== groupId) throw new Error(`MEMBER_NOT_FOUND ${memberId}`);
    return member;
  }

  private audit(actor: string, action: string, target: string, result: string): void {
    this.store.appendAudit?.({
      at: this.clock.now(),
      actor,
      action,
      target,
      result,
    });
  }
}
