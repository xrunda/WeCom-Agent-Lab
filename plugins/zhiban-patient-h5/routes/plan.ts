/**
 * PH5-04（#233）患者 H5 计划域路由（契约 api §5）。
 *
 * 患者只能看到已发布版本；未审核、生成中、被退回的一律不可见（A04）。
 * 调整申请写入 followup_requests 最小记录，供 PH5-07 的团队工作台接管。
 */
import { H5Error } from '../../../src/p1/patient-h5.ts';
import { PlanError } from '../../../src/p1/patient-h5-plan.ts';
import type {
  CalendarItemRecord,
  HealthPlanRecord,
  PlanBackend,
  PlanService,
} from '../../../src/p1/patient-h5-plan.ts';
import type { H5RouteExtension } from '../http.ts';

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

/** 域表适配器：health_plans + calendar_items */
export class DomainPlanBackend implements PlanBackend {
  private readonly plans: AnyTable;
  private readonly items: AnyTable;
  private readonly tenantId: string;

  constructor(plans: AnyTable, items: AnyTable, tenantId: string) {
    this.plans = plans;
    this.items = items;
    this.tenantId = tenantId;
  }

  load(): { plans: HealthPlanRecord[]; calendarItems: CalendarItemRecord[] } {
    const values = <T>(table: AnyTable): T[] =>
      [...table.entries()].map(([, value]) => value as T);
    return {
      plans: values<HealthPlanRecord>(this.plans).filter((item) => item.tenantId === this.tenantId),
      calendarItems: values<CalendarItemRecord>(this.items).filter(
        (item) => item.tenantId === this.tenantId,
      ),
    };
  }

  async putPlan(record: HealthPlanRecord): Promise<void> {
    await this.plans.put(record.id, record);
  }

  async putCalendarItem(record: CalendarItemRecord): Promise<void> {
    await this.items.put(record.id, record);
  }
}

/** 调整申请存储（followup_requests 的最小形态，PH5-07 接管处理流程） */
export interface PlanAdjustBackend {
  put(record: {
    id: string;
    tenantId: string;
    patientId: string;
    kind: 'plan_adjust';
    message: string;
    linkedPlanId: string;
    planVersion: number;
    riskLevel: 'low';
    status: 'pending';
    createdAt: number;
    updatedAt: number;
  }): Promise<void>;
}

export function planToView(record: HealthPlanRecord) {
  return {
    id: record.id,
    version: record.version,
    status: record.status,
    stageGoal: record.stageGoal,
    startDate: record.startDate,
    endDate: record.endDate,
    foodTherapyRationale: record.foodTherapyRationale,
    focusPoints: record.focusPoints,
    actions: record.actions,
    feedbackRequirements: record.feedbackRequirements,
    rationale: {
      basedOn: record.inputSnapshot.profileEntryIds.length
        ? ['基于你已确认的档案信息', '依据已审核的食养原则']
        : ['依据已审核的食养原则'],
      ruleRefs: record.ruleRefs,
    },
    review: {
      reviewerName: record.review.reviewerName ?? null,
      reviewedAt: record.review.reviewedAt ?? null,
    },
    publishedAt: record.effectiveFrom ?? record.updatedAt,
    effectiveFrom: record.effectiveFrom ?? null,
    effectiveTo: record.effectiveTo ?? null,
    acknowledgedAt: record.acknowledgedAt ?? null,
  };
}

function planError(error: unknown): never {
  if (error instanceof PlanError) {
    const code =
      error.code === 'PLAN_VERSION_CONFLICT'
        ? 'CONFLICT'
        : error.code === 'UPSTREAM_UNAVAILABLE'
          ? 'UPSTREAM_UNAVAILABLE'
          : error.code;
    throw new H5Error(code as never, error.message);
  }
  throw error;
}

export function createPlanRoutes(options: {
  plan: PlanService;
  adjust: PlanAdjustBackend;
  ids: (prefix: string) => string;
  now?: () => number;
}): H5RouteExtension[] {
  const now = options.now ?? Date.now;

  /** GET /plan/current —— 只返回患者可见版本 */
  const current: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/plan/current' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const record = options.plan.currentForPatient(view.session.patientId);
    if (!record) throw new H5Error('NOT_FOUND', '暂无已发布方案');
    ctx.ok(200, { plan: planToView(record) });
    return true;
  };

  /** GET /plan/versions/:version —— 历史版本只读 */
  const version: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/plan\/versions\/(\d+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const wanted = Number(match[1]);
    const record = options.plan
      .list(view.session.patientId)
      .find(
        (item) =>
          item.version === wanted &&
          (item.status === 'published' ||
            item.status === 'suspended' ||
            item.status === 'ended' ||
            item.status === 'superseded'),
      );
    if (!record) throw new H5Error('NOT_FOUND', '版本不存在');
    ctx.ok(200, { plan: planToView(record) });
    return true;
  };

  /** POST /plan/acknowledge */
  const acknowledge: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/plan/acknowledge' || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    try {
      const record = await options.plan.acknowledge(view.session.patientId);
      await ctx.service.recordEvent(view.session.patientId, 'h5.plan_acknowledge');
      ctx.ok(200, { acknowledgedAt: record.acknowledgedAt ?? now() });
    } catch (error) {
      planError(error);
    }
    return true;
  };

  /** POST /plan/adjust-requests —— 「计划不适合」 */
  const adjust: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/plan/adjust-requests' || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const currentPlan = options.plan.currentForPatient(view.session.patientId);
    if (!currentPlan) throw new H5Error('NOT_FOUND', '暂无已发布方案');
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      throw new H5Error('VALIDATION_FAILED', '请说明需要调整的地方', [
        { field: 'message', issue: 'required' },
      ]);
    }
    const version =
      typeof body.planVersion === 'number' ? body.planVersion : currentPlan.version;
    const at = now();
    const id = options.ids('fup');
    await options.adjust.put({
      id,
      tenantId: view.session.tenantId,
      patientId: view.session.patientId,
      kind: 'plan_adjust',
      message: message.slice(0, 500),
      linkedPlanId: currentPlan.id,
      planVersion: version,
      riskLevel: 'low',
      status: 'pending',
      createdAt: at,
      updatedAt: at,
    });
    ctx.ok(201, { id, status: 'pending' });
    return true;
  };

  return [current, version, acknowledge, adjust];
}
