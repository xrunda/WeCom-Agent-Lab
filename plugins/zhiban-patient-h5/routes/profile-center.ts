/**
 * PH5-10（#239）个人中心路由（契约 api §4.1、§7.5、§10）。
 *
 * 统计全部由有效数据复算；纠错只置「待确认」并进团队待办。
 */
import { H5Error, localDateKey } from '../../../src/p1/patient-h5.ts';
import type { ProfileCenterService } from '../../../src/p1/patient-h5-profile-center.ts';
import type { H5RouteExtension } from '../http.ts';

export function createProfileCenterRoutes(options: {
  center: ProfileCenterService;
  tenantReminderDefaults: { dailyLimit: number; quietHours: { start: string; end: string } };
}): H5RouteExtension[] {
  /** GET /me/stats */
  const stats: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/me/stats' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    ctx.ok(200, options.center.stats(view.session.patientId));
    return true;
  };

  /** GET /records/history?date= —— 按日查看（与 /records 同义，路径更直观） */
  const history: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/records/history' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const date = ctx.query.get('date') ?? undefined;
    const patientId = view.session.patientId;
    const resolvedDate = date ?? localDateKey(Date.now());
    ctx.ok(200, {
      items: options.center.recordsOn(patientId, date),
      // 群存档里提取的餐食：只读展示，带不带照片由 hasPhoto 决定
      archiveMeals: options.center.archiveMeals(patientId, resolvedDate),
      ...(date ? { date } : {}),
    });
    return true;
  };

  /** POST /profile/corrections —— 档案纠错 */
  const correction: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/profile/corrections' || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
    if (!entryId || !detail) {
      throw new H5Error('VALIDATION_FAILED', '请选择要更正的条目并说明原因', [
        { field: 'entryId', issue: 'required' },
      ]);
    }
    try {
      const result = await options.center.requestCorrection({
        patientId: view.session.patientId,
        entryId,
        detail,
      });
      ctx.ok(201, { followupId: result.followupId, entry: result.entry });
    } catch (error) {
      throw new H5Error(
        'VALIDATION_FAILED',
        error instanceof Error ? error.message : '提交失败',
      );
    }
    return true;
  };

  /** GET /reminder-prefs */
  const getPrefs: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/reminder-prefs' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    ctx.ok(200, {
      ...options.center.prefs(view.session.patientId),
      tenantDefaults: options.tenantReminderDefaults,
    });
    return true;
  };

  /** PATCH /reminder-prefs —— 只能更严格，放宽的请求被收窄 */
  const patchPrefs: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/reminder-prefs' || ctx.method !== 'PATCH') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const patch: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.gentleInquiry === 'boolean') patch.gentleInquiry = body.gentleInquiry;
    if (typeof body.dailyLimit === 'number') patch.dailyLimit = body.dailyLimit;
    if (body.quietHours && typeof body.quietHours === 'object') {
      const quiet = body.quietHours as { start?: unknown; end?: unknown };
      if (typeof quiet.start === 'string' && typeof quiet.end === 'string') {
        patch.quietHours = { start: quiet.start, end: quiet.end };
      }
    }
    const next = await options.center.updatePrefs(
      view.session.patientId,
      patch as never,
      options.tenantReminderDefaults,
    );
    ctx.ok(200, { ...next, tenantDefaults: options.tenantReminderDefaults });
    return true;
  };

  return [stats, history, correction, getPrefs, patchPrefs];
}
