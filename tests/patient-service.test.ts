import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryPatientStore } from '../src/p1/patient-store.ts';
import type { PatientStoreBackend, PatientSnapshot } from '../src/p1/patient-store.ts';
import { PatientService } from '../src/p1/patient-service.ts';
import { setupPatient, observeServiceGroup, TENANT } from './p1-helpers.ts';

test('#33 含外部成员的群自动登记为 pending，不触发回合', () => {
  const h = setupPatient();
  const group = observeServiceGroup(h);

  assert.equal(group.status, 'pending');
  assert.equal(group.externalMemberCount, 1);
  assert.equal(h.service.isServiceable('wr_g1', 'wm_patient'), 'none');

  const decision = h.service.routeInbound({
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '你好',
    msgtime: h.clock.now(),
  });
  assert.equal(decision.action, 'ignore');
  assert.equal(decision.reason, 'GROUP_PENDING');
});

test('#33 serving 触发回合；collect_only 只写上下文；disabled 不处理', () => {
  const h = setupPatient();
  const group = observeServiceGroup(h, { status: 'serving', advisorId: 'adv_1' });
  const message = {
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '晚上吃什么',
    msgtime: h.clock.now(),
  };

  const serving = h.service.routeInbound(message);
  assert.equal(serving.action, 'turn');
  assert.ok(serving.patientId);

  h.service.setGroupStatus(group.id, 'collect_only');
  const collect = h.service.routeInbound({ ...message, msgid: 'm2' });
  assert.equal(collect.action, 'context');
  assert.equal(collect.reason, 'COLLECT_ONLY');
  assert.equal(collect.patientId, serving.patientId);

  h.service.setGroupStatus(group.id, 'disabled');
  const disabled = h.service.routeInbound({ ...message, msgid: 'm3' });
  assert.equal(disabled.action, 'ignore');
  assert.equal(disabled.reason, 'GROUP_DISABLED');
});

test('#60 上线：控制台可列出服务群并一次更新名称/状态/顾问', () => {
  const h = setupPatient();
  const group = observeServiceGroup(h, { status: 'pending' });
  assert.deepEqual(
    h.service.listGroups().map((item) => item.id),
    [group.id],
  );

  const updated = h.service.updateGroup(group.id, {
    name: '陈嘉禾',
    status: 'serving',
    advisorId: 'adv_1',
  });
  assert.equal(updated.name, '陈嘉禾');
  assert.equal(updated.nameSource, 'config');
  assert.equal(updated.status, 'serving');
  assert.equal(updated.advisorId, 'adv_1');
  assert.equal(h.service.isServiceable('wr_g1', 'wm_patient'), 'serve');

  assert.equal(h.service.findGroup('grp_missing'), undefined);
  assert.throws(() => h.service.updateGroup(group.id, { name: '   ' }), /EMPTY_GROUP_NAME/);
  assert.throws(
    () => h.service.updateGroup(group.id, { name: '李四', advisorId: 'adv_missing' }),
    /ADVISOR_NOT_FOUND/,
  );
  // 校验失败时整次更新不落库
  assert.equal(h.service.findGroup(group.id)?.name, '陈嘉禾');
  assert.equal(h.service.findGroup(group.id)?.advisorId, 'adv_1');
});

test('#33 两个群绑定同一患者，消息归到同一患者', () => {
  const h = setupPatient();
  const g1 = observeServiceGroup(h, { roomId: 'wr_g1', status: 'serving', advisorId: 'adv_1' });
  const g2 = observeServiceGroup(h, { roomId: 'wr_g2', status: 'serving', advisorId: 'adv_1' });
  const p1 = h.service.routeInbound({
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '在吗',
    msgtime: h.clock.now(),
  });
  assert.ok(p1.patientId);

  h.service.bindPatient(g2.id, p1.patientId!, false);
  const p2 = h.service.routeInbound({
    msgid: 'm2',
    roomId: 'wr_g2',
    from: 'wm_patient',
    text: '今天血压',
    msgtime: h.clock.now(),
  });
  assert.equal(p2.patientId, p1.patientId);
  assert.deepEqual(h.service.groupIdsFor(p1.patientId!).sort(), [g1.id, g2.id].sort());
});

test('#33 群成员角色：外部默认 unknown，内部员工自动 advisor / colleague', () => {
  const h = setupPatient();
  const group = observeServiceGroup(h, {
    externalIds: ['wm_patient', 'wm_family'],
    staffIds: ['wang.guwen', 'li.colleague'],
  });
  const members = h.store.listMembers(group.id);
  const external = members.find((m) => m.externalUserId === 'wm_patient');
  const advisor = members.find((m) => m.staffUserId === 'wang.guwen');
  const colleague = members.find((m) => m.staffUserId === 'li.colleague');
  assert.equal(external?.role, 'unknown');
  assert.equal(advisor?.role, 'advisor');
  assert.equal(colleague?.role, 'colleague');
});

test('#33 内部员工发言只作上下文，不产出回合', () => {
  const h = setupPatient();
  observeServiceGroup(h, { status: 'serving' });
  const decision = h.service.routeInbound({
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wang.guwen',
    text: '我直接回了',
    msgtime: h.clock.now(),
  });
  assert.equal(decision.action, 'context');
  assert.equal(decision.reason, 'INTERNAL_STAFF');
  assert.equal(h.store.stats().turns, 0);
});

test('#33 未同意存档：disagreed 不自动服务并给出提示', () => {
  const h = setupPatient({ requireConsentForTurn: true });
  const group = observeServiceGroup(h, { status: 'serving' });
  h.service.routeInbound({
    msgid: 'm0',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '第一次',
    msgtime: h.clock.now(),
  });
  const patient = h.service.patientForGroup(group.id);
  assert.ok(patient);
  h.service.setMemberConsent(group.id, 'wm_patient', 'disagreed');

  const decision = h.service.routeInbound({
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '你好',
    msgtime: h.clock.now(),
  });
  assert.equal(decision.action, 'ignore');
  assert.equal(decision.reason, 'CONSENT_MISSING');
  assert.match(decision.consentNotice ?? '', /未同意存档/);

  h.service.setMemberConsent(group.id, 'wm_patient', 'agreed');
  const allowed = h.service.routeInbound({
    msgid: 'm2',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '再问一次',
    msgtime: h.clock.now(),
  });
  assert.equal(allowed.action, 'turn');
});

test('#33 手工标注「本人」后同意状态刷新到患者', () => {
  const h = setupPatient();
  const group = observeServiceGroup(h, { status: 'serving' });
  const member = h.store.findMember(group.id, 'wm_patient');
  assert.ok(member);
  h.service.routeInbound({
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '你好',
    msgtime: h.clock.now(),
  });
  h.service.annotateMember(group.id, member.id, 'self');
  h.service.setMemberConsent(group.id, 'wm_patient', 'agreed');

  const patient = h.service.patientForGroup(group.id);
  assert.equal(patient?.consent, 'agreed');
  assert.equal(patient?.externalUserId, 'wm_patient');
});

test('#33 重启后群状态、绑定与患者会话不丢', async () => {
  let snapshot: PatientSnapshot = {
    advisors: [],
    groups: [],
    members: [],
    bindings: [],
    patients: [],
    sessions: [],
  };
  const backend: PatientStoreBackend = {
    load: () => snapshot,
    async put(table, key, value) {
      const list = (snapshot[table as keyof PatientSnapshot] ?? []) as unknown as Array<Record<string, unknown>>;
      if (table === 'stats') {
        snapshot.stats = value as PatientSnapshot['stats'];
        return;
      }
      if (table === 'audit') {
        snapshot.audits = [...(snapshot.audits ?? []), value as never];
        return;
      }
      const index = list.findIndex((item) => item.id === key || item.patientId === key);
      if (index >= 0) list[index] = value as Record<string, unknown>;
      else list.push(value as Record<string, unknown>);
      (snapshot as unknown as Record<string, unknown>)[table] = list;
    },
    async delete() {
      return false;
    },
  };

  const store1 = new MemoryPatientStore({ backend });
  const clock = { now: () => 1_700_000_000_000 };
  const service1 = new PatientService(store1, clock, { tenantId: TENANT });
  service1.upsertAdvisor({ id: 'adv_1', wecomUserId: 'wang.guwen', name: '王顾问' });
  const group = service1.observeGroup(
    'wr_g1',
    [{ id: 'wm_patient', isExternal: true, displayName: '张女士', lastActiveAt: clock.now() }],
    { groupName: '张女士' },
  );
  service1.setGroupStatus(group.id, 'serving');
  service1.setGroupAdvisor(group.id, 'adv_1');
  service1.routeInbound({
    msgid: 'm1',
    roomId: 'wr_g1',
    from: 'wm_patient',
    text: '你好',
    msgtime: clock.now(),
  });
  const patient = service1.patientForGroup(group.id);
  assert.ok(patient);
  store1.saveSession({
    patientId: patient.id,
    sessionId: 'session_persisted',
    workspacePath: '/tmp/ws',
    createdAt: clock.now(),
  });
  await store1.flush();

  const store2 = new MemoryPatientStore({ backend });
  const service2 = new PatientService(store2, clock, { tenantId: TENANT });
  const reloaded = store2.getGroupByRoomId('wr_g1');
  assert.equal(reloaded?.status, 'serving');
  assert.equal(reloaded?.advisorId, 'adv_1');
  assert.equal(service2.patientForGroup(reloaded!.id)?.id, patient.id);
  assert.equal(store2.getSession(patient.id)?.sessionId, 'session_persisted');
});
