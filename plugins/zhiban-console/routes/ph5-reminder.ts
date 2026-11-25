/**
 * PH5-09（#238）提醒任务看板（契约 api §12.6）。
 *
 * 发送动作复用现有草稿链，本路由只负责查看与取消，不新增发送通道。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import type { ReminderRecord, ReminderStatus } from '../../../src/p1/patient-h5-reminder.ts';
import type { AuthActor } from '../auth.ts';
import { jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

export interface ReminderApi {
  list(query: { patientId?: string; status?: string; date?: string }): ReminderRecord[];
  usage(patientId: string, date?: string): { used: number; limit: number };
  cancel(id: string, reason: never): Promise<ReminderRecord>;
  enqueue(id: string): Promise<ReminderRecord>;
  generateForPatient(patientId: string): Promise<ReminderRecord[]>;
}

export interface ReminderRouteDeps {
  router: Router;
  getReminder: () => ReminderApi | undefined;
  tenantActor: (rc: RouteContext) => AuthActor;
  patientExists: (patientId: string) => boolean;
  audit: (actor: AuthActor, action: string, detail: Record<string, unknown>) => void;
}

const STATUSES: readonly ReminderStatus[] = [
  'generated',
  'advisor_pending',
  'sent',
  'verified',
  'send_failed',
  'cancelled',
];

export function registerPatientH5ReminderRoutes(deps: ReminderRouteDeps): void {
  const { router } = deps;

  const api = (): ReminderApi => {
    const instance = deps.getReminder();
    if (!instance) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者 H5 服务未就绪');
    return instance;
  };

  router.add(
    'GET',
    '/reminder-tasks',
    (rc) => {
      const actor = deps.tenantActor(rc);
      void actor;
      const patientId = rc.query.get('patientId') ?? undefined;
      const date = rc.query.get('date') ?? undefined;
      const statusRaw = rc.query.get('status');
      const status = STATUSES.includes(statusRaw as ReminderStatus)
        ? (statusRaw as ReminderStatus)
        : undefined;
      const items = api().list({
        ...(patientId ? { patientId } : {}),
        ...(date ? { date } : {}),
        ...(status ? { status } : {}),
      });
      const counts = Object.fromEntries(
        STATUSES.map((entry) => [entry, items.filter((item) => item.status === entry).length]),
      );
      jsonResponse(rc.res, 200, { items, counts }, rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'GET',
    '/patients/:id/reminder-usage',
    (rc) => {
      const patientId = String(rc.params.id ?? '');
      if (!patientId || !deps.patientExists(patientId)) {
        throw new ConsoleError('NOT_FOUND', '患者不存在');
      }
      const date = rc.query.get('date') ?? undefined;
      jsonResponse(rc.res, 200, api().usage(patientId, date), rc.requestId);
    },
    { permission: 'patient.read' },
  );

  router.add(
    'POST',
    '/patients/:id/reminder-tasks/generate',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      const patientId = String(rc.params.id ?? '');
      if (!patientId || !deps.patientExists(patientId)) {
        throw new ConsoleError('NOT_FOUND', '患者不存在');
      }
      const created = await api().generateForPatient(patientId);
      deps.audit(actor, 'h5.reminder.generate', { patientId, count: created.length });
      jsonResponse(rc.res, 200, { items: created }, rc.requestId);
    },
    { permission: 'patient.write' },
  );

  router.add(
    'POST',
    '/reminder-tasks/:id/cancel',
    async (rc) => {
      const actor = deps.tenantActor(rc);
      const id = String(rc.params.id ?? '');
      const record = await api().cancel(id, 'team_cancelled' as never);
      deps.audit(actor, 'h5.reminder.cancel', { reminderId: id, patientId: record.patientId });
      jsonResponse(rc.res, 200, { reminder: record }, rc.requestId);
    },
    { permission: 'patient.write' },
  );
}
