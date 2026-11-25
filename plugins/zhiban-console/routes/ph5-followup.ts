/**
 * PH5-07（#236）团队跟进队列（契约 api §12.3）。
 *
 * 认领才是「首次人工响应」；自动回执只是系统说了一声「已收到」。
 * scope=self 的账号只能看到并处理名下患者的请求（越权按 404 处理）。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import { FollowupError } from '../../../src/p1/patient-h5-followup.ts';
import type { FollowupView } from '../../../src/p1/patient-h5-followup.ts';
import type { AuthActor } from '../auth.ts';
import { jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

export interface FollowupApi {
  list(query: { status?: string; patientIds?: string[] }): FollowupView[];
  claim(input: { id: string; accountId: string; accountName: string }): Promise<FollowupView>;
  resolve(input: { id: string; accountId: string; note: string }): Promise<FollowupView>;
  unresolvedCount(patientIds?: string[]): { pending: number; overdue: number };
  escalateOverdue(): Promise<{ escalated: string[]; stillUnassigned: string[] }>;
  get(id: string): { patientId: string } | undefined;
}

export interface FollowupRouteDeps {
  router: Router;
  getFollowup: () => FollowupApi | undefined;
  tenantActor: (rc: RouteContext) => AuthActor;
  /** scope=self 时返回名下患者 id；undefined 表示全租户 */
  patientScope: (actor: AuthActor) => string[] | undefined;
  audit: (
    actor: AuthActor,
    action: string,
    followupId: string,
    patientId: string,
  ) => void;
  /** scope=self 时越权按 404 处理，不暴露资源存在性 */
  assertScope: (actor: AuthActor, patientId: string | undefined) => void;
}

function toConsoleError(error: unknown): never {
  if (error instanceof FollowupError) {
    const map = {
      NOT_FOUND: 'NOT_FOUND',
      VALIDATION_FAILED: 'VALIDATION_FAILED',
      FOLLOWUP_CLOSED: 'CONFLICT',
      FORBIDDEN: 'FORBIDDEN',
    } as const;
    throw new ConsoleError(map[error.code], error.message);
  }
  throw error;
}

export function registerPatientH5FollowupRoutes(deps: FollowupRouteDeps): void {
  const { router } = deps;

  router.add(
    'GET',
    '/followup-requests',
    (rc) => {
      const api = deps.getFollowup();
      if (!api) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
      const actor = deps.tenantActor(rc);
      const scope = deps.patientScope(actor);
      const statusRaw = rc.query.get('status');
      const status =
        statusRaw === 'pending' || statusRaw === 'claimed' || statusRaw === 'resolved'
          ? statusRaw
          : undefined;
      const items = api.list({
        ...(status ? { status } : {}),
        ...(scope ? { patientIds: scope } : {}),
      });
      jsonResponse(rc.res, 200, { items }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'GET',
    '/followup-requests/unresolved-count',
    (rc) => {
      const api = deps.getFollowup();
      if (!api) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
      const actor = deps.tenantActor(rc);
      const scope = deps.patientScope(actor);
      jsonResponse(rc.res, 200, api.unresolvedCount(scope), rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/followup-requests/:id/claim',
    async (rc) => {
      const api = deps.getFollowup();
      if (!api) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
      const actor = deps.tenantActor(rc);
      const id = String(rc.params.id ?? '');
      deps.assertScope(actor, api.get(id)?.patientId);
      try {
        const view = await api.claim({
          id,
          accountId: actor.account.id,
          accountName: actor.account.displayName,
        });
        deps.audit(actor, 'h5.followup.claim', id, view.id);
        jsonResponse(rc.res, 200, { request: view }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/followup-requests/:id/resolve',
    async (rc) => {
      const api = deps.getFollowup();
      if (!api) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
      const actor = deps.tenantActor(rc);
      const id = String(rc.params.id ?? '');
      deps.assertScope(actor, api.get(id)?.patientId);
      const body = await rc.json<{ note?: string }>();
      try {
        const view = await api.resolve({
          id,
          accountId: actor.account.id,
          note: body.note ?? '',
        });
        deps.audit(actor, 'h5.followup.resolve', id, view.id);
        jsonResponse(rc.res, 200, { request: view }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/followup-requests/escalate-overdue',
    async (rc) => {
      const api = deps.getFollowup();
      if (!api) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
      const actor = deps.tenantActor(rc);
      if (actor.account.role !== 'admin' && actor.account.role !== 'supervisor') {
        throw new ConsoleError('FORBIDDEN', '只有主管可以触发升级');
      }
      const result = await api.escalateOverdue();
      jsonResponse(rc.res, 200, result, rc.requestId);
    },
    { permission: 'patient.write' },
  );
}
