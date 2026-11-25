/**
 * PH5-07（#236）患者侧团队联系路由（契约 api §8）。
 *
 * 首期不做实时问诊：提交后进入团队队列，答复沿现有会话人工送达，
 * H5 只展示处理状态与返回指引，不承诺唤起指定微信会话。
 */
import { H5Error } from '../../../src/p1/patient-h5.ts';
import { FollowupError } from '../../../src/p1/patient-h5-followup.ts';
import type { FollowupService } from '../../../src/p1/patient-h5-followup.ts';
import type { H5RouteExtension } from '../http.ts';

function toH5Error(error: unknown): never {
  if (error instanceof FollowupError) {
    const map = {
      NOT_FOUND: 'NOT_FOUND',
      VALIDATION_FAILED: 'VALIDATION_FAILED',
      FOLLOWUP_CLOSED: 'CONFLICT',
      FORBIDDEN: 'FORBIDDEN',
    } as const;
    throw new H5Error(map[error.code], error.message);
  }
  throw error;
}

export interface TeamInfo {
  advisorName: string;
  members: Array<{ name: string; role: string }>;
  serviceHours: string;
  categories: Array<{ key: string; label: string }>;
}

export function createFollowupRoutes(options: {
  followups: FollowupService;
  team: (patientId: string) => TeamInfo;
}): H5RouteExtension[] {
  /** GET /team —— 真实名册与服务安排 */
  const team: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/team' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    ctx.ok(200, options.team(view.session.patientId));
    return true;
  };

  /** POST /team/requests —— 留言 */
  const submit: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/team/requests' || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const category = typeof body.category === 'string' ? body.category : 'other';
    if (!['plan', 'record', 'body', 'other'].includes(category)) {
      throw new H5Error('VALIDATION_FAILED', '留言分类非法', [
        { field: 'category', issue: 'invalid' },
      ]);
    }
    try {
      const record = await options.followups.create({
        patientId: view.session.patientId,
        kind: 'question',
        message: typeof body.message === 'string' ? body.message : '',
        ...(typeof body.linkedPlanId === 'string' ? { linkedPlanId: body.linkedPlanId } : {}),
        ...(typeof body.linkedCalendarItemId === 'string'
          ? { linkedCalendarItemId: body.linkedCalendarItemId }
          : {}),
      });
      ctx.ok(201, {
        id: record.id,
        status: record.status,
        // 自动回执只是「已收到」，不代表已处理（A11）
        acknowledged: true,
        autoAckAt: record.autoAckSentAt,
      });
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** GET /team/requests —— 我的请求与状态 */
  const list: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/team/requests' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    ctx.ok(200, { items: options.followups.listForPatient(view.session.patientId) });
    return true;
  };

  /** GET /team/requests/:id */
  const detail: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/team\/requests\/([^/]+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    try {
      ctx.ok(200, options.followups.getForPatient(view.session.patientId, match[1]!));
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** POST /team/requests/:id/close —— 患者撤销 */
  const close: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/team\/requests\/([^/]+)\/close$/.exec(ctx.path);
    if (!match || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    try {
      ctx.ok(200, await options.followups.closeByPatient(view.session.patientId, match[1]!));
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  return [submit, detail, close, list, team];
}
