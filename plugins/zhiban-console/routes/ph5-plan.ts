/**
 * PH5-04（#233）团队端方案审核接口（契约 api §12.2）。
 *
 * 审核能力 `h5.plan.review` 与角色矩阵分开：默认不授予任何人（含 admin），
 * 必须通过账号上的 h5Permissions 显式分配——专业审核是业务职责，
 * 不能因为「是管理员」就默认可发布个性化健康方案（PRD §2.2）。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import { PlanError } from '../../../src/p1/patient-h5-plan.ts';
import type { HealthPlanRecord } from '../../../src/p1/patient-h5-plan.ts';
import type { AuthActor } from '../auth.ts';
import { jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

export interface PlanApi {
  list(patientId: string): HealthPlanRecord[];
  get(id: string): HealthPlanRecord | undefined;
  generate(input: {
    patientId: string;
    startDate: string;
    endDate: string;
    actorId: string;
  }): Promise<HealthPlanRecord>;
  createManualDraft(input: {
    patientId: string;
    startDate: string;
    endDate: string;
    actorId: string;
    stageGoal?: string;
  }): Promise<HealthPlanRecord>;
  update(input: {
    planId: string;
    actorId: string;
    expectedVersion: number;
    patch: Record<string, unknown>;
  }): Promise<HealthPlanRecord>;
  reject(input: {
    planId: string;
    actorId: string;
    actorName: string;
    note: string;
  }): Promise<HealthPlanRecord>;
  publish(input: {
    planId: string;
    actorId: string;
    actorName: string;
    note?: string;
  }): Promise<HealthPlanRecord>;
  suspend(input: { planId: string; actorId: string }): Promise<HealthPlanRecord>;
  resume(input: { planId: string; actorId: string }): Promise<HealthPlanRecord>;
  end(input: { planId: string; actorId: string }): Promise<HealthPlanRecord>;
}

export interface PlanRouteDeps {
  router: Router;
  getPlan: () => PlanApi | undefined;
  tenantActor: (rc: RouteContext) => AuthActor;
  patientExists: (patientId: string) => boolean;
  audit: (actor: AuthActor, action: string, plan: HealthPlanRecord) => void;
}

/** 只有显式授予 h5.plan.review 的账号才能发布/退回/暂停（默认无人） */
function requireReviewPermission(actor: AuthActor): void {
  const granted = actor.account.h5Permissions ?? [];
  if (!granted.includes('h5.plan.review')) {
    throw new ConsoleError('FORBIDDEN', '当前账号没有方案审核能力，请联系管理员开通');
  }
}

function toConsoleError(error: unknown): never {
  if (error instanceof PlanError) {
    const map: Record<string, 'NOT_FOUND' | 'VALIDATION_FAILED' | 'CONFLICT' | 'IMMUTABLE_RESOURCE' | 'UPSTREAM_UNAVAILABLE'> = {
      NOT_FOUND: 'NOT_FOUND',
      VALIDATION_FAILED: 'VALIDATION_FAILED',
      CONFLICT: 'CONFLICT',
      PLAN_VERSION_CONFLICT: 'CONFLICT',
      IMMUTABLE_RESOURCE: 'IMMUTABLE_RESOURCE',
      UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
      DATA_PENDING: 'VALIDATION_FAILED',
      FORBIDDEN: 'FORBIDDEN' as never,
    };
    throw new ConsoleError(map[error.code] ?? 'INTERNAL', error.message);
  }
  throw error;
}

function planView(record: HealthPlanRecord) {
  return {
    id: record.id,
    patientId: record.patientId,
    version: record.version,
    status: record.status,
    stageGoal: record.stageGoal,
    startDate: record.startDate,
    endDate: record.endDate,
    foodTherapyRationale: record.foodTherapyRationale,
    focusPoints: record.focusPoints,
    actions: record.actions,
    feedbackRequirements: record.feedbackRequirements,
    generation: record.generation,
    review: record.review,
    reviewHistory: record.reviewHistory,
    inputSnapshot: { profileEntryCount: record.inputSnapshot.profileEntryIds.length, takenAt: record.inputSnapshot.takenAt },
    ruleRefs: record.ruleRefs,
    effectiveFrom: record.effectiveFrom ?? null,
    effectiveTo: record.effectiveTo ?? null,
    updatedAt: record.updatedAt,
  };
}

function requireApi(deps: PlanRouteDeps) {
  const api = deps.getPlan();
  if (!api) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
  return api;
}

export function registerPatientH5PlanRoutes(deps: PlanRouteDeps): void {
  const { router } = deps;

  router.add(
    'GET',
    '/patients/:id/health-plans',
    (rc) => {
      const api = requireApi(deps);
      const patientId = String(rc.params.id ?? '');
      if (!patientId || !deps.patientExists(patientId)) {
        throw new ConsoleError('NOT_FOUND', '患者不存在');
      }
      const items = api.list(patientId).map(planView);
      jsonResponse(rc.res, 200, { items }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'GET',
    '/health-plans/:id',
    (rc) => {
      const api = requireApi(deps);
      const record = api.get(String(rc.params.id ?? ''));
      if (!record) throw new ConsoleError('NOT_FOUND', '方案不存在');
      jsonResponse(rc.res, 200, { plan: planView(record) }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/patients/:id/health-plans/generate',
    async (rc) => {
      const api = requireApi(deps);
      const actor = deps.tenantActor(rc);
      requireReviewPermission(actor);
      const patientId = String(rc.params.id ?? '');
      if (!patientId || !deps.patientExists(patientId)) {
        throw new ConsoleError('NOT_FOUND', '患者不存在');
      }
      const body = await rc.json<{ startDate?: string; endDate?: string }>();
      if (!body.startDate || !body.endDate) {
        throw new ConsoleError('VALIDATION_FAILED', '缺少方案起止日期');
      }
      try {
        const record = await api.generate({
          patientId,
          startDate: body.startDate,
          endDate: body.endDate,
          actorId: actor.account.id,
        });
        deps.audit(actor, 'h5.plan.generate', record);
        jsonResponse(rc.res, 202, { plan: planView(record) }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/patients/:id/health-plans/manual',
    async (rc) => {
      const api = requireApi(deps);
      const actor = deps.tenantActor(rc);
      requireReviewPermission(actor);
      const patientId = String(rc.params.id ?? '');
      if (!patientId || !deps.patientExists(patientId)) {
        throw new ConsoleError('NOT_FOUND', '患者不存在');
      }
      const body = await rc.json<{ startDate?: string; endDate?: string; stageGoal?: string }>();
      if (!body.startDate || !body.endDate) {
        throw new ConsoleError('VALIDATION_FAILED', '缺少方案起止日期');
      }
      try {
        const record = await api.createManualDraft({
          patientId,
          startDate: body.startDate,
          endDate: body.endDate,
          actorId: actor.account.id,
          ...(body.stageGoal ? { stageGoal: body.stageGoal } : {}),
        });
        deps.audit(actor, 'h5.plan.manual_draft', record);
        jsonResponse(rc.res, 201, { plan: planView(record) }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'PATCH',
    '/health-plans/:id',
    async (rc) => {
      const api = requireApi(deps);
      const actor = deps.tenantActor(rc);
      requireReviewPermission(actor);
      const body = await rc.json<{ expectedVersion?: number } & Record<string, unknown>>();
      if (typeof body.expectedVersion !== 'number') {
        throw new ConsoleError('VALIDATION_FAILED', '缺少 expectedVersion');
      }
      const { expectedVersion, ...patch } = body;
      try {
        const record = await api.update({
          planId: String(rc.params.id ?? ''),
          actorId: actor.account.id,
          expectedVersion,
          patch,
        });
        deps.audit(actor, 'h5.plan.update', record);
        jsonResponse(rc.res, 200, { plan: planView(record) }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/health-plans/:id/reject',
    async (rc) => {
      const api = requireApi(deps);
      const actor = deps.tenantActor(rc);
      requireReviewPermission(actor);
      const body = await rc.json<{ note?: string }>();
      try {
        const record = await api.reject({
          planId: String(rc.params.id ?? ''),
          actorId: actor.account.id,
          actorName: actor.account.displayName,
          note: body.note ?? '',
        });
        deps.audit(actor, 'h5.plan.reject', record);
        jsonResponse(rc.res, 200, { plan: planView(record) }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/health-plans/:id/publish',
    async (rc) => {
      const api = requireApi(deps);
      const actor = deps.tenantActor(rc);
      requireReviewPermission(actor);
      const body = await rc.json<{ note?: string }>();
      try {
        const record = await api.publish({
          planId: String(rc.params.id ?? ''),
          actorId: actor.account.id,
          actorName: actor.account.displayName,
          ...(body.note ? { note: body.note } : {}),
        });
        deps.audit(actor, 'h5.plan.publish', record);
        jsonResponse(rc.res, 200, { plan: planView(record) }, rc.requestId);
      } catch (error) {
        toConsoleError(error);
      }
    },
    { permission: 'patient.write' },
  );

  for (const action of ['suspend', 'resume', 'end'] as const) {
    router.add(
      'POST',
      `/health-plans/:id/${action}`,
      async (rc) => {
        const api = requireApi(deps);
        const actor = deps.tenantActor(rc);
        requireReviewPermission(actor);
        try {
          const record = await api[action]({
            planId: String(rc.params.id ?? ''),
            actorId: actor.account.id,
          });
          deps.audit(actor, `h5.plan.${action}`, record);
          jsonResponse(rc.res, 200, { plan: planView(record) }, rc.requestId);
        } catch (error) {
          toConsoleError(error);
        }
      },
      { permission: 'patient.write' },
    );
  }
}
