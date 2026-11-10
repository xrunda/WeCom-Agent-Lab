/**
 * zhiban-console DSH 插件（WP-H：#41 框架 / #39 告警中心 / #40 体验沙盒）。
 *
 * 所有接口挂在 `/zhiban/api` 前缀下，由本插件自建认证、鉴权、限流与来源校验。
 * 契约以 docs/P1-api.md 为准；服务实现可离线单测（src/p1/console-*、sandbox）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';

import {
  BusinessRateLimiter,
  isOriginAllowed,
  SESSION_COOKIE,
} from '../../src/p1/console-auth.ts';
import { AlertService } from '../../src/p1/console-alerts.ts';
import { ConsoleError } from '../../src/p1/console-error.ts';
import { ConsoleStore } from '../../src/p1/console-store.ts';
import {
  ALL_PERMISSIONS,
  hasPermission,
  paginate,
  permissionsFor,
  type AccountRecord,
  type ConsoleAuditEvent,
  type Page,
  type Permission,
  type PublicAccount,
  type Role,
} from '../../src/p1/console-types.ts';
import { EvidenceService } from '../../src/p1/evidence.ts';
import type { EvidencePatientPort, EvidenceWecomPort } from '../../src/p1/evidence.ts';
import { SandboxService } from '../../src/p1/sandbox.ts';
import type {
  SandboxAgentPort,
  SandboxAgentTurnInput,
  SandboxMediaWriter,
  SandboxPatient,
} from '../../src/p1/sandbox.ts';
import { buildSecurityOverview } from '../../src/p1/security.ts';
import type { GroupServiceStatus } from '../../src/p1/types.ts';
import { mealLogView, type MealLogRecord } from '../../src/p1/vision.ts';

import { ConsoleAuthService, publicAccount } from './auth.ts';
import type { AuthActor } from './auth.ts';
import { parseConsoleConfig } from './config.ts';
import type { ConsoleConfig } from './config.ts';
import { DomainConsoleBackend, consoleDomain } from './domain.ts';
import {
  clearCookieHeader,
  emptyResponse,
  header,
  IdempotencyCache,
  jsonResponse,
  readRawBody,
  Router,
  setCookieHeader,
} from './http.ts';
import type { HttpRequestLike, HttpResponseLike, RouteContext } from './http.ts';
import {
  renderEvidencePdf,
  renderRecordsPdf,
  requirePdfFont,
  resolvePdfFont,
} from './pdf.ts';
import { parseEventTypes, SseHub } from './sse.ts';
import { applyTenantPatch, publicTenant, validateTenantPatch } from './tenant.ts';

export const name = 'zhiban-console';

/** webServer / storageDomain 由宿主提供 */
export const inject = ['webServer', 'storageDomain'];

type EffectCleanup = void | (() => void | Promise<void>);

export interface DshWebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: HttpRequestLike, res: HttpResponseLike) => unknown;
}

export interface DshConsoleContext {
  logger?: {
    info?(line: string): void;
    warn?(line: string): void;
    error?(line: string): void;
  };
  effect(fn: () => EffectCleanup | Promise<EffectCleanup>): unknown;
  emit(type: string, data: unknown): unknown;
  provide(name: string, value: unknown): unknown;
  get<T = unknown>(name: string): T | undefined;
  on(type: string, listener: (data: unknown) => void): () => boolean;
  storageDomain: {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  };
  webServer: {
    register(route: DshWebRoute): unknown;
  };
}

/** zhiban-patient 暴露给控制台的群视图 */
interface PatientGroupViewLike {
  id: string;
  roomId: string;
  name: string;
  nameSource: string;
  status: GroupServiceStatus;
  advisorId?: string;
  patientIds: string[];
  memberCount: number;
  externalMemberCount: number;
  consent: { agreed: number; unknown: number; disagreed: number };
  lastActiveAt?: number;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
}

/** zhiban-patient 暴露给控制台的最小沙盒接口 */
interface PatientApiLike {
  applySettings?(patch: { agentName?: string; patientTerm?: string; tone?: string }): void;
  sandboxEnsure(patient: SandboxPatient): Promise<string>;
  sandboxReset(patient: SandboxPatient): Promise<string>;
  sandboxTurn(input: SandboxAgentTurnInput): Promise<void>;
  sandboxInjectContext(sessionId: string, text: string): Promise<void>;
  getPatient(id: string): { id: string; displayName: string } | undefined;
  getPatientGroups?(id: string): {
    patient: { id: string; displayName: string };
    groups: Array<{ id: string; name: string; roomId: string }>;
  } | undefined;
  consentStats?(): { agreed: number; unknown: number; disagreed: number; total: number };
  /** #55：饮食记录 */
  listMealLogs?(patientId: string): MealLogRecord[];
  /** #60 上线：群列表与服务状态入口 */
  listGroups?(): PatientGroupViewLike[];
  updateGroup?(
    groupId: string,
    patch: { name?: string; status?: GroupServiceStatus; advisorId?: string },
  ): PatientGroupViewLike;
}

/** zhiban-wecom 暴露给控制台的队列 / 顾问操作 */
interface WecomAdminLike {
  releaseQueue(
    advisorId: string,
    actor?: string,
  ): Promise<{ releasedDraftId: string; nextDraftId: string | null }>;
  restoreAdvisor(
    advisorId: string,
    actor?: string,
  ): { id: string; name: string; status: string; consecutiveMisroutes: number };
  getDraft?(draftId: string):
    | { id: string; summary: string; status: string; riskLevel: string }
    | undefined;
  getAdvisor?(advisorId: string): { id: string; name: string; status: string } | undefined;
  getDraftEvidence?(draftId: string): Promise<unknown>;
  listDraftsByRooms?(roomIds: string[], from: number, to: number): Promise<unknown[]>;
}

const API_PREFIX = '/zhiban/api';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const GROUP_STATUSES: readonly GroupServiceStatus[] = [
  'pending',
  'serving',
  'collect_only',
  'disabled',
];

function parseGroupStatus(value: unknown): GroupServiceStatus {
  if (typeof value === 'string' && (GROUP_STATUSES as readonly string[]).includes(value)) {
    return value as GroupServiceStatus;
  }
  throw new ConsoleError('VALIDATION_FAILED', `status 必须是 ${GROUP_STATUSES.join(' / ')}`);
}

/** SSE 事件清单（docs/P1-api.md §15）；未知事件不会订阅 */
const FORWARDED_EVENTS = [
  'draft.created',
  'draft.pushed',
  'draft.acked',
  'draft.revised',
  'draft.verified',
  'draft.failed',
  'draft.released',
  'patient.created',
  'patient.updated',
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'care_plan.created',
  'care_plan.fired',
  'care_plan.cancelled',
  'meal_log.created',
  'group.updated',
  'group.member.updated',
  'advisor.updated',
  'system.status',
] as const;

const ROLE_LABEL: Record<Exclude<Role, 'platform'>, string> = {
  admin: '机构管理员',
  supervisor: '主管',
  viewer: '只读',
};

/** 账号页与数据安全页共用同一份角色权限矩阵，避免两处口径漂移 */
function rolePermissionMatrix(): Array<{ role: string; label: string; permissions: string[] }> {
  return (['admin', 'supervisor', 'viewer'] as const).map((role) => ({
    role,
    label: ROLE_LABEL[role],
    permissions: role === 'admin' ? ['*'] : permissionsFor(role),
  }));
}

function nowMs(): number {
  return Date.now();
}

function isSandboxEvent(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.sandbox === true) return true;
  if (typeof record.patientId === 'string' && record.patientId.startsWith('pat_sandbox_')) return true;
  if (typeof record.sessionId === 'string' && record.sessionId.startsWith('sbx_')) return true;
  return false;
}

function accountView(account: AccountRecord | PublicAccount): Record<string, unknown> {
  const base = 'passwordHash' in account ? publicAccount(account) : account;
  return { ...base, deletedAt: account.deletedAt ?? null };
}

function parseTime(raw: string | null, field: string): number | undefined {
  if (raw === null || raw === '') return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 必须是毫秒时间戳或 ISO 8601`, [
      { field, issue: 'invalid time' },
    ]);
  }
  return parsed;
}

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function auditActor(actor: AuthActor): { id: string; name: string; role: string } {
  return { id: actor.account.id, name: actor.account.displayName, role: actor.account.role };
}

function auditRecord(
  tenantId: string,
  actor: AuthActor,
  action: string,
  targetType: string,
  targetId: string | null,
  detail?: Record<string, unknown>,
  sandbox = false,
): Omit<ConsoleAuditEvent, 'id' | 'at'> {
  return {
    tenantId,
    actorType: actor.account.role === 'platform' ? 'platform' : 'account',
    actorId: actor.account.id,
    actorName: actor.account.displayName,
    action,
    targetType,
    targetId,
    result: 'success',
    detail,
    sandbox,
  };
}

/** 从 multipart/form-data 中取出 file 字段；只解析这一种简单表单 */
export function parseMultipartFile(
  body: Buffer,
  contentType: string,
  field = 'file',
): { filename?: string; contentType?: string; data: Buffer } {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  if (boundary === '') {
    throw new ConsoleError('VALIDATION_FAILED', 'multipart 缺少 boundary');
  }
  const delimiter = Buffer.from(`--${boundary}`);
  let position = body.indexOf(delimiter);
  while (position >= 0) {
    const next = body.indexOf(delimiter, position + delimiter.length);
    const end = next < 0 ? body.length : next;
    const part = body.subarray(position + delimiter.length, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const head = part.subarray(0, headerEnd).toString('utf8');
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      if (name === field) {
        let data = part.subarray(headerEnd + 4);
        if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
          data = data.subarray(0, data.length - 2);
        }
        return {
          filename: /filename="([^"]*)"/i.exec(head)?.[1],
          contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim(),
          data,
        };
      }
    }
    if (next < 0) break;
    position = next;
  }
  throw new ConsoleError('VALIDATION_FAILED', `multipart 缺少 ${field} 字段`, [
    { field, issue: 'missing file' },
  ]);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function createMediaWriter(config: ConsoleConfig): SandboxMediaWriter {
  const root = config.sandbox.mediaRootDir || join(process.cwd(), '.zhiban-console-media');
  return {
    async write(mediaId: string, extension: string, data: Buffer): Promise<string> {
      const safeId = mediaId.replace(/[^A-Za-z0-9_-]/g, '');
      const path = join(root, `${safeId}.${extension}`);
      await mkdir(root, { recursive: true });
      await writeFile(path, data);
      return path;
    },
  };
}

export function apply(ctx: DshConsoleContext, rawConfig: unknown): void {
  const config = parseConsoleConfig(rawConfig);
  const log = (line: string): void => ctx.logger?.info?.(`[zhiban-console] ${line}`);

  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(consoleDomain);
    const store = new ConsoleStore({
      backend: new DomainConsoleBackend(domain),
      onPersistError: (error) => log(`领域存储写入失败：${error.message}`),
    });

    const hub = new SseHub();
    const publish = (type: string, data: unknown, sandbox = false): void => {
      hub.publish(type, data, { tenantId: config.tenantId, sandbox });
    };

    const auth = new ConsoleAuthService({
      store,
      config,
      emit: (type, data) => publish(type, data),
    });
    await auth.initialize();

    const alerts = new AlertService({
      tenantId: config.tenantId,
      store,
      emit: (type, data) => publish(type, data),
      ops: () => {
        const admin = ctx.get<WecomAdminLike>('zhibanWecomAdmin');
        if (!admin) return undefined;
        return {
          releaseQueue: (advisorId: string) => admin.releaseQueue(advisorId, 'console'),
          restoreAdvisor: async (advisorId: string) => {
            const advisor = await admin.restoreAdvisor(advisorId, 'console');
            return {
              id: advisor.id,
              name: advisor.name,
              status: 'active' as const,
              consecutiveMisroutes: advisor.consecutiveMisroutes,
            };
          },
        };
      },
    });

    const sandbox = new SandboxService({
      tenantId: config.tenantId,
      store,
      timezone: auth.tenant.timezone,
      emit: (type, data) => publish(type, data, true),
      dailyLimit: config.sandbox.dailyLimit,
      mediaWriter: createMediaWriter(config),
      agent: () => {
        const api = ctx.get<PatientApiLike>('zhibanPatient');
        if (!api || typeof api.sandboxEnsure !== 'function') return undefined;
        const port: SandboxAgentPort = {
          ensureSession: (patient) => api.sandboxEnsure(patient),
          resetSession: (patient) => api.sandboxReset(patient),
          runTurn: (input) => api.sandboxTurn(input),
          injectContext: (sessionId, text) => api.sandboxInjectContext(sessionId, text),
        };
        return port;
      },
    });
    // 患者运行时通过这个服务把沙盒草稿交回来（而不是进入 C2 队列）
    ctx.provide('zhibanSandboxSink', sandbox);

    // #59：证据链 / 服务记录导出。数据来自企微插件与患者插件的只读入口。
    const pdfFont = resolvePdfFont({
      path: config.pdf.fontPath,
      family: config.pdf.fontFamily,
    });
    if (!pdfFont) {
      log('未找到中文字体：导出 PDF 将返回 502，请安装 fonts-noto-cjk 或配置 pdf.fontPath');
    }
    const evidence = new EvidenceService({
      tenantName: config.tenant.name,
      wecom: () =>
        ctx.get<WecomAdminLike>('zhibanWecomAdmin') as unknown as EvidenceWecomPort | undefined,
      patient: () =>
        ctx.get<PatientApiLike>('zhibanPatient') as unknown as EvidencePatientPort | undefined,
    });
    const sendPdf = (
      rc: RouteContext,
      filename: string,
      buffer: Buffer,
    ): void => {
      rc.res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': buffer.length,
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${filename}"`,
        'x-request-id': rc.requestId,
      });
      rc.res.end(buffer);
    };

    const businessLimiter = new BusinessRateLimiter();
    const idempotency = new IdempotencyCache();

    const actorOf = (rc: RouteContext): AuthActor => {
      const actor = auth.resolve(rc.req);
      if (!actor) throw new ConsoleError('UNAUTHORIZED', '未登录或会话已过期');
      return actor;
    };
    /** platform 不属于任何租户：所有租户接口一律 404（P1-api §1.6） */
    const tenantActor = (rc: RouteContext): AuthActor => {
      const actor = actorOf(rc);
      if (actor.account.role === 'platform') {
        throw new ConsoleError('NOT_FOUND', '接口不存在');
      }
      return actor;
    };
    const respond = (rc: RouteContext, status: number, body: unknown): void => {
      jsonResponse(rc.res, status, body, rc.requestId);
    };
    const idempotent = async (
      rc: RouteContext,
      scope: string,
      run: () => Promise<{ status: number; body: unknown }>,
    ): Promise<void> => {
      const key = header(rc.req, 'idempotency-key');
      if (!key) {
        const result = await run();
        respond(rc, result.status, result.body);
        return;
      }
      const actor = actorOf(rc);
      const cacheKey = `${actor.account.id}:${scope}:${key}`;
      const hit = idempotency.get(cacheKey, nowMs());
      if (hit) {
        jsonResponse(rc.res, hit.status, hit.body, rc.requestId, {
          ...hit.headers,
          'x-idempotent-replay': 'true',
        });
        return;
      }
      const result = await run();
      idempotency.set(cacheKey, nowMs(), result.status, result.body);
      respond(rc, result.status, result.body);
    };

    const router = new Router({
      basePath: API_PREFIX,
      auth: (req) => {
        const actor = auth.resolve(req);
        return actor ? { accountId: actor.account.id } : undefined;
      },
      authorize: (accountId, permission) => {
        const account = store.getAccount(accountId);
        if (!account) return false;
        if (account.role === 'platform') return true; // 由各 handler 统一 404
        return hasPermission(account.role, permission as Permission);
      },
      rateLimit: (accountId) => {
        const wait = businessLimiter.retryAfterSeconds(accountId, nowMs());
        if (wait > 0) {
          throw new ConsoleError('RATE_LIMITED', `请求过于频繁，请 ${wait} 秒后再试`);
        }
      },
      checkOrigin: (req) => {
        if (!isOriginAllowed(header(req, 'origin'), header(req, 'host'), config.allowedOrigins)) {
          throw new ConsoleError('FORBIDDEN', '请求来源不合法');
        }
      },
    });

    // ---------- 认证与会话 ----------

    router.add(
      'POST',
      '/auth/login',
      async (rc) => {
        const body = await rc.json<Record<string, unknown>>();
        const result = await auth.login(body.username, body.password, auth.requestIp(rc.req));
        jsonResponse(
          rc.res,
          200,
          {
            account: accountView(result.account),
            tenant: result.tenant
              ? {
                  id: result.tenant.id,
                  name: result.tenant.name,
                  agentName: result.tenant.agentName,
                  patientTerm: result.tenant.patientTerm,
                }
              : null,
          },
          rc.requestId,
          {
            'set-cookie': setCookieHeader(
              SESSION_COOKIE,
              result.token,
              config.sessionTtlMs / 1000,
              config.cookieSecure,
            ),
          },
        );
      },
      { auth: false },
    );

    router.add('POST', '/auth/logout', (rc) => {
      const actor = actorOf(rc);
      auth.logout(actor.tokenHash, actor);
      emptyResponse(rc.res, 204, rc.requestId, {
        'set-cookie': clearCookieHeader(SESSION_COOKIE, config.cookieSecure),
      });
    });

    router.add('GET', '/auth/session', (rc) => {
      respond(rc, 200, auth.sessionView(actorOf(rc)));
    });

    router.add('POST', '/auth/password', async (rc) => {
      const actor = actorOf(rc);
      const body = await rc.json<Record<string, unknown>>();
      await auth.changePassword(actor, body.currentPassword, body.newPassword);
      emptyResponse(rc.res, 204, rc.requestId);
    });

    // ---------- 租户 ----------

    router.add(
      'GET',
      '/tenant',
      (rc) => {
        tenantActor(rc);
        respond(rc, 200, publicTenant(auth.tenant));
      },
      { permission: 'tenant.read' },
    );

    router.add(
      'PATCH',
      '/tenant',
      async (rc) => {
        const actor = tenantActor(rc);
        const body = await rc.json<Record<string, unknown>>();
        const patch = validateTenantPatch(body, auth.tenant);
        const updated = applyTenantPatch(auth.tenant, patch, nowMs());
        store.saveTenant(updated);
        sandbox.setTimezone(updated.timezone);
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'tenant.update', 'tenant', updated.id, {
            fields: Object.keys(body),
          }),
        );
        // 保存即生效：下一轮 Agent 回合使用新人设（#41）
        const patient = ctx.get<PatientApiLike>('zhibanPatient');
        if (patient?.applySettings) {
          patient.applySettings({
            agentName: updated.agentName,
            patientTerm: updated.patientTerm,
            tone: updated.tone,
          });
        }
        respond(rc, 200, publicTenant(updated));
      },
      { permission: 'tenant.write' },
    );

    // ---------- 告警中心（#39） ----------

    const alertQuery = (rc: RouteContext): Parameters<AlertService['list']>[0] => ({
      kind: rc.query.get('kind') ?? undefined,
      status: rc.query.get('status') ?? undefined,
      advisorId: rc.query.get('advisorId') ?? undefined,
      patientId: rc.query.get('patientId') ?? undefined,
      from: parseTime(rc.query.get('from'), 'from'),
      to: parseTime(rc.query.get('to'), 'to'),
      sandbox: rc.query.get('sandbox') === 'true',
      page: positiveInt(rc.query.get('page'), 1),
      pageSize: positiveInt(rc.query.get('pageSize'), 20),
    });

    router.add(
      'GET',
      '/alerts',
      (rc) => {
        tenantActor(rc);
        respond(rc, 200, alerts.list(alertQuery(rc)));
      },
      { permission: 'alert.read' },
    );

    router.add(
      'GET',
      '/alerts/unresolved-count',
      (rc) => {
        tenantActor(rc);
        respond(rc, 200, alerts.unresolvedCount());
      },
      { permission: 'alert.read' },
    );

    router.add(
      'GET',
      '/alerts/:id',
      (rc) => {
        tenantActor(rc);
        const alert = alerts.get(rc.params.id!);
        const wecom = ctx.get<WecomAdminLike>('zhibanWecomAdmin');
        const patientApi = ctx.get<PatientApiLike>('zhibanPatient');
        respond(rc, 200, {
          alert,
          draft: alert.draftId ? wecom?.getDraft?.(alert.draftId) ?? null : null,
          patient: alert.patientId ? patientApi?.getPatient?.(alert.patientId) ?? null : null,
          advisor: alert.advisorId ? wecom?.getAdvisor?.(alert.advisorId) ?? null : null,
        });
      },
      { permission: 'alert.read' },
    );

    router.add(
      'POST',
      '/alerts/:id/resolve',
      async (rc) => {
        const id = rc.params.id!;
        await idempotent(rc, `alert.resolve:${id}`, async () => {
          const actor = tenantActor(rc);
          const body = await rc.json<Record<string, unknown>>();
          return { status: 200, body: alerts.resolve(id, body.note, auditActor(actor)) };
        });
      },
      { permission: 'alert.write' },
    );

    router.add(
      'POST',
      '/alerts/:id/release-queue',
      async (rc) => {
        const id = rc.params.id!;
        await idempotent(rc, `alert.release:${id}`, async () => {
          const actor = tenantActor(rc);
          const result = await alerts.releaseQueue(id, auditActor(actor));
          return { status: 200, body: result };
        });
      },
      { permission: 'advisor.operate' },
    );

    router.add(
      'POST',
      '/alerts/:id/restore-advisor',
      async (rc) => {
        const id = rc.params.id!;
        await idempotent(rc, `alert.restore:${id}`, async () => {
          const actor = tenantActor(rc);
          const result = await alerts.restoreAdvisor(id, auditActor(actor));
          return { status: 200, body: result };
        });
      },
      { permission: 'advisor.operate' },
    );

    // ---------- 饮食记录（#55） ----------

    router.add(
      'GET',
      '/patients/:id/meal-logs',
      (rc) => {
        tenantActor(rc);
        const patientApi = ctx.get<PatientApiLike>('zhibanPatient');
        const patient = patientApi?.getPatient?.(rc.params.id!);
        if (!patient) throw new ConsoleError('NOT_FOUND', '患者不存在');
        const from = parseTime(rc.query.get('from'), 'from');
        const to = parseTime(rc.query.get('to'), 'to');
        const items = (patientApi?.listMealLogs?.(patient.id) ?? [])
          .filter(
            (log) =>
              (from === undefined || log.createdAt >= from) &&
              (to === undefined || log.createdAt <= to),
          )
          .map((log) => mealLogView(log));
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'patient.read' },
    );

    // ---------- 服务群（#60 上线：状态入口） ----------

    router.add(
      'GET',
      '/groups',
      (rc) => {
        tenantActor(rc);
        const patientApi = ctx.get<PatientApiLike>('zhibanPatient');
        if (!patientApi?.listGroups) {
          throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
        }
        const status = rc.query.get('status');
        const advisorId = rc.query.get('advisorId');
        const q = rc.query.get('q')?.trim().toLowerCase();
        let items = patientApi.listGroups();
        if (status) items = items.filter((group) => group.status === parseGroupStatus(status));
        if (advisorId) items = items.filter((group) => group.advisorId === advisorId);
        if (q) {
          items = items.filter(
            (group) =>
              group.name.toLowerCase().includes(q) || group.roomId.toLowerCase().includes(q),
          );
        }
        const sort = rc.query.get('sort') ?? '-lastActiveAt';
        const desc = sort.startsWith('-');
        const key = desc ? sort.slice(1) : sort;
        if (key !== 'lastActiveAt' && key !== 'name' && key !== 'updatedAt') {
          throw new ConsoleError('VALIDATION_FAILED', 'sort 必须是 lastActiveAt / name / updatedAt');
        }
        items.sort((a, b) => {
          const left = key === 'name' ? a.name : key === 'updatedAt' ? a.updatedAt : a.lastActiveAt ?? 0;
          const right = key === 'name' ? b.name : key === 'updatedAt' ? b.updatedAt : b.lastActiveAt ?? 0;
          const compared =
            typeof left === 'string' && typeof right === 'string'
              ? left.localeCompare(right, 'zh-CN')
              : Number(left) - Number(right);
          return desc ? -compared : compared;
        });
        respond(
          rc,
          200,
          paginate(
            items,
            positiveInt(rc.query.get('page'), 1),
            positiveInt(rc.query.get('pageSize'), 20),
          ),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'PATCH',
      '/groups/:id',
      async (rc) => {
        const actor = tenantActor(rc);
        const patientApi = ctx.get<PatientApiLike>('zhibanPatient');
        if (!patientApi?.updateGroup) {
          throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
        }
        const body = await rc.json<Record<string, unknown>>();
        const patch: { name?: string; status?: GroupServiceStatus; advisorId?: string } = {};
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || body.name.trim().length === 0) {
            throw new ConsoleError('VALIDATION_FAILED', 'name 必须是非空字符串');
          }
          patch.name = body.name;
        }
        if (body.status !== undefined) patch.status = parseGroupStatus(body.status);
        if (body.advisorId !== undefined) {
          if (typeof body.advisorId !== 'string' || body.advisorId.trim().length === 0) {
            throw new ConsoleError('VALIDATION_FAILED', 'advisorId 必须是非空字符串');
          }
          patch.advisorId = body.advisorId;
        }
        if (Object.keys(patch).length === 0) {
          throw new ConsoleError('VALIDATION_FAILED', '至少提供一个可更新字段');
        }
        let group: PatientGroupViewLike;
        try {
          group = patientApi.updateGroup(rc.params.id!, patch);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('GROUP_NOT_FOUND')) {
            throw new ConsoleError('NOT_FOUND', '群不存在');
          }
          if (message.startsWith('ADVISOR_NOT_FOUND')) {
            throw new ConsoleError('VALIDATION_FAILED', '顾问不存在');
          }
          if (message.startsWith('EMPTY_GROUP_NAME')) {
            throw new ConsoleError('VALIDATION_FAILED', '群名不能为空');
          }
          throw error;
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'group.update', 'group', group.id, {
            fields: Object.keys(patch),
          }),
        );
        respond(rc, 200, group);
      },
      { permission: 'patient.write' },
    );

    // ---------- 沙盒（#40） ----------

    router.add(
      'POST',
      '/sandbox/session',
      async (rc) => {
        const actor = tenantActor(rc);
        const view = await sandbox.ensureSession(actor.account.id);
        respond(rc, 200, view);
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'GET',
      '/sandbox/session',
      (rc) => {
        const actor = tenantActor(rc);
        const record = store.getSandboxSession(actor.account.id);
        if (!record) throw new ConsoleError('NOT_FOUND', '沙盒会话不存在，请先创建');
        respond(rc, 200, sandbox.sessionView(record));
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'POST',
      '/sandbox/session/reset',
      async (rc) => {
        const actor = tenantActor(rc);
        const view = await sandbox.reset(actor.account.id);
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'sandbox.reset', 'sandbox_session', view.session.id, undefined, true),
        );
        respond(rc, 200, view);
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'POST',
      '/sandbox/messages',
      async (rc) => {
        const actor = tenantActor(rc);
        const body = await rc.json<Record<string, unknown>>();
        const result = await sandbox.postMessage(actor.account.id, {
          kind: body.kind,
          text: body.text,
          mediaId: body.mediaId,
        });
        store.appendAudit(
          auditRecord(
            config.tenantId,
            actor,
            'sandbox.message',
            'sandbox_message',
            result.messageId,
            { kind: body.kind === 'image' ? 'image' : 'text' },
            true,
          ),
        );
        respond(rc, 202, result);
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'GET',
      '/sandbox/state',
      (rc) => {
        const actor = tenantActor(rc);
        const since = parseTime(rc.query.get('since'), 'since');
        respond(rc, 200, sandbox.state(actor.account.id, since));
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'POST',
      '/sandbox/drafts/:draftId/actions',
      async (rc) => {
        const draftId = rc.params.draftId!;
        await idempotent(rc, `sandbox.action:${draftId}`, async () => {
          const actor = tenantActor(rc);
          const body = await rc.json<Record<string, unknown>>();
          const result = sandbox.action(actor.account.id, draftId, {
            action: body.action,
            editedBody: body.editedBody,
            targetGroupId: body.targetGroupId,
          });
          store.appendAudit(
            auditRecord(config.tenantId, actor, 'sandbox.action', 'sandbox_draft', draftId, {
              outcome: result.outcome,
            }, true),
          );
          return { status: 200, body: result };
        });
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'POST',
      '/sandbox/uploads',
      async (rc) => {
        const actor = tenantActor(rc);
        const contentType = header(rc.req, 'content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
          throw new ConsoleError('VALIDATION_FAILED', '必须使用 multipart/form-data');
        }
        const raw = await readRawBody(rc.req, MAX_UPLOAD_BYTES + 1024 * 1024);
        const file = parseMultipartFile(raw, contentType, 'file');
        const media = await sandbox.saveUpload(actor.account.id, {
          filename: file.filename,
          contentType: file.contentType,
          data: file.data,
        });
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'media.upload', 'media', media.mediaId, {
            size: media.size,
            contentType: file.contentType ?? null,
          }, true),
        );
        respond(rc, 201, media);
      },
      { permission: 'sandbox.use' },
    );

    router.add(
      'GET',
      '/media/:mediaId',
      async (rc) => {
        const actor = tenantActor(rc);
        const media = sandbox.media(actor.account.id, rc.params.mediaId!);
        let data: Buffer;
        try {
          data = await readFile(media.path);
        } catch {
          throw new ConsoleError('NOT_FOUND', '媒体文件不存在');
        }
        rc.res.writeHead(200, {
          'content-type': media.contentType,
          'content-length': data.length,
          'cache-control': 'private, max-age=300',
          'x-request-id': rc.requestId,
        });
        rc.res.end(data);
      },
      { permission: 'patient.read' },
    );

    // ---------- 账号 / 审计 ----------

    const accountPage = (accounts: Array<Record<string, unknown>>, rc: RouteContext): Page<Record<string, unknown>> =>
      paginate(accounts, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20));

    router.add(
      'GET',
      '/accounts',
      (rc) => {
        tenantActor(rc);
        const accounts = auth
          .listAccounts({
            role: rc.query.get('role') ?? undefined,
            status: rc.query.get('status') ?? undefined,
            includeDeleted: rc.query.get('includeDeleted') === 'true',
          })
          .map((account) => accountView(account as AccountRecord));
        respond(rc, 200, accountPage(accounts, rc));
      },
      { permission: 'account.write' },
    );

    router.add(
      'GET',
      '/accounts/permission-matrix',
      (rc) => {
        tenantActor(rc);
        respond(rc, 200, {
          roles: rolePermissionMatrix(),
          allPermissions: ALL_PERMISSIONS,
        });
      },
    );

    router.add(
      'POST',
      '/accounts',
      async (rc) => {
        const actor = tenantActor(rc);
        const body = await rc.json<Record<string, unknown>>();
        const account = await auth.createAccount(actor, body);
        respond(rc, 201, accountView(account as AccountRecord));
      },
      { permission: 'account.write' },
    );

    router.add(
      'PATCH',
      '/accounts/:id',
      async (rc) => {
        const actor = tenantActor(rc);
        const body = await rc.json<Record<string, unknown>>();
        const account = auth.updateAccount(actor, rc.params.id!, body);
        respond(rc, 200, accountView(account as AccountRecord));
      },
      { permission: 'account.write' },
    );

    router.add(
      'POST',
      '/accounts/:id/reset-password',
      async (rc) => {
        const actor = tenantActor(rc);
        const body = await rc.json<Record<string, unknown>>();
        await auth.resetPassword(actor, rc.params.id!, body.newPassword);
        emptyResponse(rc.res, 204, rc.requestId);
      },
      { permission: 'account.write' },
    );

    router.add(
      'DELETE',
      '/accounts/:id',
      (rc) => {
        const actor = tenantActor(rc);
        auth.deleteAccount(actor, rc.params.id!);
        emptyResponse(rc.res, 204, rc.requestId);
      },
      { permission: 'account.write' },
    );

    const auditFilter = (rc: RouteContext): ((event: ConsoleAuditEvent) => boolean) => {
      const from = parseTime(rc.query.get('from'), 'from');
      const to = parseTime(rc.query.get('to'), 'to');
      const sandboxParam = rc.query.get('sandbox');
      const sandbox = sandboxParam === null ? false : sandboxParam === 'true';
      return (event) =>
        event.tenantId === config.tenantId &&
        event.sandbox === sandbox &&
        (!rc.query.get('actorType') || event.actorType === rc.query.get('actorType')) &&
        (!rc.query.get('actorId') || event.actorId === rc.query.get('actorId')) &&
        (!rc.query.get('action') || event.action === rc.query.get('action')) &&
        (!rc.query.get('targetType') || event.targetType === rc.query.get('targetType')) &&
        (!rc.query.get('targetId') || event.targetId === rc.query.get('targetId')) &&
        (!rc.query.get('result') || event.result === rc.query.get('result')) &&
        (from === undefined || event.at >= from) &&
        (to === undefined || event.at < to);
    };

    router.add(
      'GET',
      '/audit',
      (rc) => {
        tenantActor(rc);
        const filter = auditFilter(rc);
        const items = store
          .listAudits()
          .filter(filter)
          .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
        respond(rc, 200, paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)));
      },
      { permission: 'audit.read' },
    );

    router.add(
      'GET',
      '/audit/export.csv',
      (rc) => {
        const actor = tenantActor(rc);
        const filter = auditFilter(rc);
        const items = store
          .listAudits()
          .filter(filter)
          .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
        const columns = [
          'id',
          'tenantId',
          'actorType',
          'actorId',
          'actorName',
          'action',
          'targetType',
          'targetId',
          'result',
          'errorCode',
          'ip',
          'at',
          'sandbox',
        ];
        const lines = [columns.join(',')];
        for (const event of items) {
          const row = event as unknown as Record<string, unknown>;
          lines.push(
            columns
              .map((column) =>
                column === 'at'
                  ? new Date(event.at).toISOString()
                  : csvCell(row[column]),
              )
              .join(','),
          );
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'audit.export', 'audit', null, {
            rows: items.length,
            filters: Object.fromEntries(
              ['actorType', 'actorId', 'action', 'targetType', 'targetId', 'result', 'from', 'to', 'sandbox']
                .filter((key) => rc.query.get(key) !== null)
                .map((key) => [key, rc.query.get(key)]),
            ),
          }),
        );
        const csv = `﻿${lines.join('\r\n')}\r\n`;
        rc.res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(csv),
          'x-request-id': rc.requestId,
          'content-disposition': 'attachment; filename="audit.csv"',
        });
        rc.res.end(csv);
      },
      { permission: 'export' },
    );

    // ---------- 数据与安全 / 导出（#59） ----------

    router.add(
      'GET',
      '/settings/security',
      (rc) => {
        tenantActor(rc);
        const patientApi = ctx.get<PatientApiLike>('zhibanPatient');
        const tenant = store.getTenant(config.tenantId);
        if (!tenant) throw new ConsoleError('NOT_FOUND', '租户不存在');
        respond(
          rc,
          200,
          buildSecurityOverview({
            dataRegion: config.deployment.region,
            modelRegion: config.deployment.modelRegion,
            modelService: config.deployment.modelService,
            cookieSecure: config.cookieSecure,
            mediaRootDir: config.sandbox.mediaRootDir,
            modelName: tenant.settings.modelName,
            retentionNotice: tenant.settings.retentionNotice,
            consent: patientApi?.consentStats?.() ?? null,
            roles: rolePermissionMatrix(),
            audits: store.listAudits(),
            now: nowMs(),
            pdfFontConfigured: pdfFont !== undefined,
          }),
        );
      },
      { permission: 'tenant.read' },
    );

    router.add(
      'GET',
      '/drafts/:draftId/evidence.pdf',
      async (rc) => {
        const actor = tenantActor(rc);
        const bundle = await evidence.draftEvidence(rc.params.draftId!, actor.account.displayName);
        const buffer = await renderEvidencePdf(bundle, requirePdfFont(pdfFont));
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'evidence.export', 'draft', bundle.draft.id, {
            bytes: buffer.length,
          }),
        );
        sendPdf(
          rc,
          `evidence-${bundle.draft.id.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`,
          buffer,
        );
      },
      { permission: 'export' },
    );

    router.add(
      'GET',
      '/patients/:id/records.pdf',
      async (rc) => {
        const actor = tenantActor(rc);
        const bundle = await evidence.patientRecords(rc.params.id!, actor.account.displayName, {
          from: parseTime(rc.query.get('from'), 'from'),
          to: parseTime(rc.query.get('to'), 'to'),
        });
        const buffer = await renderRecordsPdf(bundle, requirePdfFont(pdfFont));
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'records.export', 'patient', bundle.patient.id, {
            bytes: buffer.length,
            records: bundle.records.length,
            from: bundle.from,
            to: bundle.to,
          }),
        );
        sendPdf(rc, `records-${bundle.patient.id.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`, buffer);
      },
      { permission: 'export' },
    );

    // ---------- SSE ----------

    router.add('GET', '/stream', (rc) => {
      tenantActor(rc);
      const lastEventId =
        header(rc.req, 'last-event-id') ?? rc.query.get('lastEventId') ?? undefined;
      hub.open(rc.req, rc.res, {
        tenantId: config.tenantId,
        types: parseEventTypes(rc.query.get('types')),
        lastEventId,
      });
    });

    // ---------- 订阅平台事件 ----------

    const disposers: Array<() => boolean> = [];
    disposers.push(
      ctx.on('alert.created', (data) => {
        try {
          alerts.ingest(data);
        } catch (error) {
          log(`告警入库失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    for (const type of FORWARDED_EVENTS) {
      disposers.push(
        ctx.on(type, (data) => {
          if (type === 'memory.created' || type === 'memory.updated' || type === 'memory.deleted') {
            sandbox.ingestMemoryEvent(type, data);
          }
          publish(type, data, isSandboxEvent(data));
        }),
      );
    }

    const routeDisposer = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        void router.handle(req, res).catch((error: unknown) => {
          log(`未处理的请求错误：${error instanceof Error ? error.message : String(error)}`);
        });
      },
    });

    log(
      `已就绪：前缀=${API_PREFIX} 租户=${config.tenantId} ` +
        `沙盒日限=${config.sandbox.dailyLimit}`,
    );

    return async () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 已卸载
        }
      }
      hub.closeAll();
      if (typeof routeDisposer === 'function') {
        (routeDisposer as () => void)();
      }
      await store.flush();
      await domain.close();
      log('已停止并落盘');
    };
  });
}

/** 供测试与文档复用：账号对外视图（无密码哈希） */
export { accountView };
