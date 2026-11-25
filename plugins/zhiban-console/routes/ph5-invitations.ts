/**
 * PH5-02（#231）患者 H5 团队端接口（docs/PATIENT-H5-api.md §12.1、§12.7、§12.8）。
 *
 * 只做 HTTP 适配与权限；身份/授权服务由 `zhiban-patient-h5` 提供，
 * 控制台通过 `ctx.get('zhibanPatientH5')` 调用，不直接读写患者 H5 存储。
 * 响应永远不含邀请 code 与完整手机号（phoneTail 展示）。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import type {
  ConsentStatus,
  H5SessionRecord,
  InvitationRecord,
  PrivacyRequestRecord,
} from '../../../src/p1/patient-h5.ts';
import { emptyResponse, jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

import type { AuthActor } from '../auth.ts';

export interface PatientH5RouteDeps {
  router: Router;
  /** 懒加载 zhiban-patient-h5 插件暴露的 API */
  getH5: () =>
    | {
        createInvitation(input: {
          patientId: string;
          phone: string;
          ttlHours?: number;
          note?: string;
          createdBy: string;
        }): Promise<InvitationRecord>;
        listInvitations(patientId: string): InvitationRecord[];
        invitationView(record: InvitationRecord): Omit<InvitationRecord, 'code' | 'phone'>;
        revokeInvitation(id: string, revokedBy: string): Promise<InvitationRecord>;
        getBinding(patientId: string):
          | {
              id: string;
              patientId: string;
              phoneTail: string;
              status: string;
              boundAt: number;
              unboundAt?: number;
            }
          | undefined;
        listSessions(patientId: string): H5SessionRecord[];
        revokeSession(sessionId: string, by: 'account', accountId: string): Promise<void>;
        consentsView(patientId: string): Record<string, ConsentStatus>;
        listPrivacyRequests(status?: 'submitted' | 'handled' | 'rejected'): PrivacyRequestRecord[];
        handlePrivacyRequest(input: {
          id: string;
          result: 'handled' | 'rejected';
          note: string;
          handledBy: string;
        }): Promise<PrivacyRequestRecord>;
        meStatus(patientId: string): string;
        invitationLink(record: InvitationRecord): string;
        config: { tenantId: string };
      }
    | undefined;
  tenantActor: (rc: RouteContext) => AuthActor;
  /** 患者存在性校验（来自 zhiban-patient），避免对不存在患者签发邀请 */
  patientExists: (patientId: string) => boolean;
  /** 审计：只记 id 与枚举，不记手机号/code */
  audit: (
    actor: AuthActor,
    action: 'h5.invitation.create' | 'h5.invitation.revoke' | 'h5.session.revoke' | 'h5.privacy.handle',
    targetId: string,
    detail: Record<string, unknown>,
  ) => void;
}

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

function requireH5(rc: RouteContext, deps: PatientH5RouteDeps) {
  const api = deps.getH5();
  if (!api) {
    throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
  }
  return api;
}

function requirePatient(rc: RouteContext, deps: PatientH5RouteDeps): string {
  const patientId = String(rc.params.id ?? '');
  if (!patientId || !deps.patientExists(patientId)) {
    throw new ConsoleError('NOT_FOUND', '患者不存在');
  }
  return patientId;
}

function readTtlHours(rc: RouteContext): number | undefined {
  const raw = rc.query.get('ttlHours');
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= 72) return Math.floor(value);
  return undefined;
}

async function readBody<T extends Record<string, unknown>>(rc: RouteContext): Promise<T> {
  const body = await rc.json<Record<string, unknown>>();
  if (!body || typeof body !== 'object') throw new ConsoleError('VALIDATION_FAILED', '请求体非法');
  return body as T;
}

export function registerPatientH5InvitationRoutes(deps: PatientH5RouteDeps): void {
  const { router } = deps;

  // ---------- 邀请（契约 api §12.1） ----------

  router.add(
    'POST',
    '/patients/:id/invitations',
    async (rc) => {
      const api = requireH5(rc, deps);
      const patientId = requirePatient(rc, deps);
      const actor = deps.tenantActor(rc);
      const body = await readBody<{ phone?: unknown; ttlHours?: unknown; note?: unknown }>(rc);
      if (typeof body.phone !== 'string' || !PHONE_PATTERN.test(body.phone)) {
        throw new ConsoleError('VALIDATION_FAILED', '手机号格式不正确', [
          { field: 'phone', issue: 'invalid phone' },
        ]);
      }
      if (body.ttlHours !== undefined) {
        const ttl = Number(body.ttlHours);
        if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 72) {
          throw new ConsoleError('VALIDATION_FAILED', '有效期 1–72 小时');
        }
      }
      const record = await api.createInvitation({
        patientId,
        phone: body.phone,
        ...(typeof body.ttlHours === 'number' ? { ttlHours: body.ttlHours } : {}),
        ...(typeof body.note === 'string' ? { note: body.note.slice(0, 200) } : {}),
        createdBy: actor.account.id,
      });
      deps.audit(actor, 'h5.invitation.create', record.id, {
        patientId,
        advisorId: record.advisorId,
      });
      // 邀请链接一次性返回；列表接口不再回 code（契约 api §12.1）
      jsonResponse(rc.res, 201, {
        invitation: api.invitationView(record),
        link: api.invitationLink(record),
      }, rc.requestId);
    },
    { permission: 'patient.write' },
  );

  router.add(
    'GET',
    '/patients/:id/invitations',
    (rc) => {
      const api = requireH5(rc, deps);
      const patientId = requirePatient(rc, deps);
      const items = api.listInvitations(patientId).map((item) => api.invitationView(item));
      jsonResponse(rc.res, 200, { items }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/patient-invitations/:id/revoke',
    async (rc) => {
      const api = requireH5(rc, deps);
      const actor = deps.tenantActor(rc);
      const id = String(rc.params.id ?? '');
      const record = await api.revokeInvitation(id, actor.account.id);
      deps.audit(actor, 'h5.invitation.revoke', id, { patientId: record.patientId });
      jsonResponse(rc.res, 200, { invitation: api.invitationView(record) }, rc.requestId);
    },
    { permission: 'patient.write' },
  );

  // ---------- 绑定与会话（契约 api §12.1 / §12.8） ----------

  router.add(
    'GET',
    '/patients/:id/h5-binding',
    (rc) => {
      const api = requireH5(rc, deps);
      const patientId = requirePatient(rc, deps);
      const binding = api.getBinding(patientId);
      const sessions: Array<{
        id: string;
        status: H5SessionRecord['status'];
        authMethod: H5SessionRecord['authMethod'];
        issuedAt: number;
        expiresAt: number;
        lastSeenAt: number;
        revokedAt: number | null;
        userAgentSummary: string | null;
      }> = api
        .listSessions(patientId)
        .map((session) => ({
          id: session.id,
          status: session.status,
          authMethod: session.authMethod,
          issuedAt: session.issuedAt,
          expiresAt: session.expiresAt,
          lastSeenAt: session.lastSeenAt,
          revokedAt: session.revokedAt ?? null,
          userAgentSummary: session.userAgentSummary ?? null,
        }));
      jsonResponse(rc.res, 200, {
        binding: binding
          ? {
              bound: binding.status === 'bound',
              phoneTail: binding.phoneTail,
              boundAt: binding.boundAt,
              status: binding.status,
            }
          : null,
        sessions,
        consents: api.consentsView(patientId),
        h5Status: api.meStatus(patientId),
      }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/patients/:id/h5-binding/sessions/:sid/revoke',
    async (rc) => {
      const api = requireH5(rc, deps);
      const patientId = requirePatient(rc, deps);
      const actor = deps.tenantActor(rc);
      const sessionId = String(rc.params.sid ?? '');
      await api.revokeSession(sessionId, 'account', actor.account.id);
      deps.audit(actor, 'h5.session.revoke', sessionId, { patientId });
      jsonResponse(rc.res, 200, { ok: true, sessionId }, rc.requestId);
    },
    { permission: 'patient.write' },
  );

  // ---------- 隐私申请（契约 api §12.7） ----------

  router.add(
    'GET',
    '/privacy-requests',
    (rc) => {
      const api = requireH5(rc, deps);
      const statusRaw = rc.query.get('status');
      const status =
        statusRaw === 'submitted' || statusRaw === 'handled' || statusRaw === 'rejected'
          ? statusRaw
          : undefined;
      const items = api.listPrivacyRequests(status);
      jsonResponse(rc.res, 200, { items }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/privacy-requests/:id/handle',
    async (rc) => {
      const api = requireH5(rc, deps);
      const actor = deps.tenantActor(rc);
      const body = await readBody<{ result?: unknown; note?: unknown }>(rc);
      if (body.result !== 'handled' && body.result !== 'rejected') {
        throw new ConsoleError('VALIDATION_FAILED', 'result 只能是 handled 或 rejected', [
          { field: 'result', issue: 'invalid' },
        ]);
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : '';
      const record = await api.handlePrivacyRequest({
        id: String(rc.params.id ?? ''),
        result: body.result,
        note,
        handledBy: actor.account.id,
      });
      deps.audit(actor, 'h5.privacy.handle', record.id, {
        result: record.status,
        kind: record.kind,
      });
      jsonResponse(rc.res, 200, { request: record }, rc.requestId);
    },
    { permission: 'account.write' },
  );
}
