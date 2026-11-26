/**
 * PH5-05（#234）患者 H5 日历与反馈路由（契约 api §6）。
 *
 * 只读已发布方案产生的事项；访问、查看、收到提醒都不构成完成
 * （完成只由 feedback 接口或关联记录满足要求产生）。
 */
import { H5Error } from '../../../src/p1/patient-h5.ts';
import { CalendarError } from '../../../src/p1/patient-h5-calendar.ts';
import type { CalendarService } from '../../../src/p1/patient-h5-calendar.ts';
import type { H5RouteExtension } from '../http.ts';

function toH5Error(error: unknown): never {
  if (error instanceof CalendarError) {
    const map = {
      NOT_FOUND: 'NOT_FOUND',
      ITEM_NOT_MODIFIABLE: 'CONFLICT',
      VALIDATION_FAILED: 'VALIDATION_FAILED',
      SERVICE_PAUSED: 'SERVICE_PAUSED',
    } as const;
    throw new H5Error(map[error.code], error.message);
  }
  throw error;
}

export function createCalendarRoutes(options: {
  calendar: CalendarService;
  dailyTip?: { title: string; text: string };
  /** 陪伴天数（服务开始时间起算）；没有开始时间时返回 null，前端显示占位而不是 0 */
  companionDays?: (patientId: string) => number | null;
}): H5RouteExtension[] {
  /** GET /today */
  const today: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/today' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const result = options.calendar.today(view.session.patientId);
    ctx.ok(200, {
      ...result,
      greeting: greetingOf(new Date()),
      relatedArticles: [],
      companionDays: options.companionDays?.(view.session.patientId) ?? null,
    });
    return true;
  };

  /** GET /calendar?date=&from=&to= */
  const calendar: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/calendar' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const date = ctx.query.get('date') ?? undefined;
    const from = ctx.query.get('from') ?? undefined;
    const to = ctx.query.get('to') ?? undefined;
    const days = options.calendar.week(view.session.patientId, {
      ...(date ? { date } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    ctx.ok(200, {
      days,
      from: days[0]?.date ?? null,
      to: days[days.length - 1]?.date ?? null,
      ...(options.dailyTip ? { dailyTip: options.dailyTip } : {}),
    });
    return true;
  };

  /** GET /calendar/items/:id */
  const item: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/calendar\/items\/([^/]+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    try {
      ctx.ok(200, options.calendar.item(view.session.patientId, match[1]!));
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** POST /calendar/items/:id/feedback */
  const feedback: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/calendar\/items\/([^/]+)\/feedback$/.exec(ctx.path);
    if (!match || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const kind = body.kind;
    if (kind !== 'patient_confirmed' && kind !== 'missed' && kind !== 'needs_help') {
      throw new H5Error('VALIDATION_FAILED', 'kind 非法', [{ field: 'kind', issue: 'invalid' }]);
    }
    try {
      const result = await options.calendar.feedback({
        patientId: view.session.patientId,
        itemId: match[1]!,
        kind,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body.occurredAt === 'number' ? { occurredAt: body.occurredAt } : {}),
      });
      await ctx.service.recordEvent(view.session.patientId, 'h5.calendar_feedback', result.id, {
        backfill: typeof body.occurredAt === 'number',
      });
      ctx.ok(200, result);
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  return [today, calendar, item, feedback];
}

function greetingOf(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
