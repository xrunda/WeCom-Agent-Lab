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
import type { CarePlanRecord } from '../../src/p1/care.ts';
import type { MemoryRecord } from '../../src/p1/memory.ts';
import type { Draft } from '../../src/c2/types.ts';
import {
  advisorView,
  buildPatientActions,
  buildPatientTimeline,
  dashboardKpis,
  dashboardValue,
  decodeArchiveMediaId,
  draftPatient,
  patientAdvisorId,
  patientView,
  serviceFlowDetail,
  serviceFlowRow,
  type DashboardRange,
  type DraftLookups,
} from '../../src/p1/console-views.ts';
import type {
  AdvisorRecord,
  ConsentStatus,
  GroupBinding,
  GroupMember,
  GroupServiceStatus,
  Patient,
} from '../../src/p1/types.ts';
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
    groups: Array<{
      id: string;
      name: string;
      roomId: string;
      status?: GroupServiceStatus;
      isPrimary?: boolean;
    }>;
  } | undefined;
  /** 真实存量数据入口（控制台） */
  listPatients?(): Patient[];
  getPatientAdmin?(id: string): Patient | undefined;
  listAdvisors?(): AdvisorRecord[];
  getAdvisor?(id: string): AdvisorRecord | undefined;
  updatePatient?(
    id: string,
    patch: Partial<
      Pick<
        Patient,
        'displayName' | 'avatar' | 'tags' | 'advisorId' | 'consent' | 'status' | 'externalUserId'
      >
    >,
  ): Patient;
  updateAdvisor?(
    id: string,
    patch: Partial<Pick<AdvisorRecord, 'name' | 'status' | 'seatExpireAt' | 'chatBound'>>,
  ): AdvisorRecord;
  createPatient?(input: {
    displayName: string;
    externalUserId?: string;
    tags?: string[];
    advisorId?: string;
    consent?: ConsentStatus;
  }): Patient;
  bindPatient?(groupId: string, patientId: string, isPrimary?: boolean): GroupBinding;
  getPatientBindings?(id: string): Array<{ groupId: string; isPrimary: boolean }>;
  /** 确认 / 改绑患者身份：把患者指向服务群里的某位外部成员 */
  setPatientIdentity?(
    groupId: string,
    patientId: string,
    externalUserId: string,
    opts?: { displayName?: string },
  ): Patient;
  /** 群成员列表（含角色/同意状态），用于「设为患者」选择 */
  listGroupMembers?(groupId: string): GroupMember[];
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
  /** 控制台：真实草稿 / 群 / 审计读取，顾问手动暂停 */
  listDrafts?(): Draft[];
  getDraftDetail?(draftId: string): Draft | undefined;
  listGroups?(): Array<{ roomId: string; name: string; advisorId: string; status: string }>;
  listAudits?(): Array<{
    at: number;
    actor: string;
    action: string;
    target: string;
    result: string;
  }>;
  pauseAdvisor?(advisorId: string): {
    id: string;
    name: string;
    status: string;
    consecutiveMisroutes: number;
  } | undefined;
}

/** zhiban-memory 的最小控制台读接口 */
interface MemoryApiLike {
  available?(): boolean;
  list(patientId: string, query?: { category?: string; includeDeleted?: boolean }): unknown[];
  get?(id: string): unknown;
  count?(patientId: string): number;
  write?(input: Record<string, unknown>): unknown;
  update?(id: string, patch: Record<string, unknown>, actor?: string, actorId?: string): unknown;
  remove?(id: string, actor?: string, actorId?: string): unknown;
}

interface CareApiLike {
  available?(): boolean;
  list(patientId?: string, status?: string): unknown[];
  create?(input: Record<string, unknown>): unknown;
  cancel?(id: string, actor?: string): unknown;
}

interface KnowledgeApiLike {
  get?(id: string): { id: string; title: string; deletedAt?: number } | undefined;
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

    // 群成员列表：用于「在群内把某位成员设为当前 Agent 的患者」
    router.add(
      'GET',
      '/groups/:id/members',
      (rc) => {
        tenantActor(rc);
        const api = patientReadApi();
        const group = api?.listGroups?.().find((item) => item.id === rc.params.id!);
        if (!group) throw new ConsoleError('NOT_FOUND', '群不存在');
        const members = api?.listGroupMembers?.(rc.params.id!) ?? [];
        const items = members.map((member) => ({
          id: member.id,
          groupId: rc.params.id!,
          externalUserId: member.externalUserId ?? null,
          externalUserIdTail: member.externalUserIdTail ?? null,
          displayName: member.displayName,
          isExternal: member.isExternal,
          staffUserId: member.staffUserId ?? null,
          role: member.role,
          consent: member.consent,
          lastActiveAt: member.lastActiveAt ?? null,
          annotatedBy: member.annotatedBy ?? null,
          annotatedAt: member.annotatedAt ?? null,
        }));
        respond(rc, 200, { items, total: items.length });
      },
      { permission: 'patient.read' },
    );

    // ---------- 真实数据：工作台 / 患者 / 顾问 / 服务流（P1-api §4–§8） ----------

    const patientReadApi = (): PatientApiLike | undefined => ctx.get<PatientApiLike>('zhibanPatient');
    const wecomReadApi = (): WecomAdminLike | undefined => ctx.get<WecomAdminLike>('zhibanWecomAdmin');
    const memoryReadApi = (): MemoryApiLike | undefined => ctx.get<MemoryApiLike>('zhibanMemory');
    const careReadApi = (): CareApiLike | undefined => ctx.get<CareApiLike>('zhibanCare');
    const knowledgeReadApi = (): KnowledgeApiLike | undefined =>
      ctx.get<KnowledgeApiLike>('zhibanKnowledge');

    const consoleBindings = (api: PatientApiLike, patients: Patient[]): GroupBinding[] => {
      const result: GroupBinding[] = [];
      for (const patient of patients) {
        for (const binding of api.getPatientBindings?.(patient.id) ?? []) {
          result.push({
            id: `${patient.id}:${binding.groupId}`,
            tenantId: patient.tenantId,
            groupId: binding.groupId,
            patientId: patient.id,
            isPrimary: binding.isPrimary,
            createdAt: patient.createdAt,
          });
        }
      }
      return result;
    };

    /** 患者视图 + 群/顾问映射；群顾问优先取患者域，缺失时回落到企微群映射。 */
    const consoleLookups = (): DraftLookups => {
      const api = patientReadApi();
      const patients = api?.listPatients?.() ?? [];
      const advisors = api?.listAdvisors?.() ?? [];
      const mappedGroups = wecomReadApi()?.listGroups?.() ?? [];
      const groups = (api?.listGroups?.() ?? []).map((group) => {
        const mapped = mappedGroups.find((item) => item.roomId === group.roomId);
        return {
          id: group.id,
          roomId: group.roomId,
          name: group.name,
          advisorId: group.advisorId ?? mapped?.advisorId,
          demo: group.demo,
        };
      });
      return { patients, advisors, groups, bindings: api ? consoleBindings(api, patients) : [] };
    };

    const consoleDrafts = (): Draft[] => wecomReadApi()?.listDrafts?.() ?? [];

    const consoleMemories = (): MemoryRecord[] => {
      const api = memoryReadApi();
      const records: MemoryRecord[] = [];
      for (const patient of patientReadApi()?.listPatients?.() ?? []) {
        for (const item of api?.list(patient.id, { includeDeleted: true }) ?? []) {
          records.push(item as MemoryRecord);
        }
      }
      return records;
    };

    const consoleCarePlans = (): CarePlanRecord[] =>
      (careReadApi()?.list() ?? []) as CarePlanRecord[];

    const consoleMemoryCount = (patientId: string): number => {
      const api = memoryReadApi();
      if (!api) return 0;
      return api.count ? api.count(patientId) : api.list(patientId).length;
    };

    const consolePendingPlans = (patientId: string): number =>
      (careReadApi()?.list(patientId, 'pending') ?? []).length;

    const requirePatient = (id: string): Patient => {
      const patient = patientReadApi()?.getPatientAdmin?.(id);
      if (!patient) throw new ConsoleError('NOT_FOUND', '患者不存在');
      return patient;
    };

    const parseDashboardRange = (raw: string | null): DashboardRange => {
      if (raw === null || raw === '') return 'today';
      if (raw === 'today' || raw === 'week' || raw === 'month') return raw;
      throw new ConsoleError('VALIDATION_FAILED', 'range 必须是 today / week / month');
    };

    const parsePatientStatus = (raw: unknown): Patient['status'] => {
      if (raw === 'serving' || raw === 'paused' || raw === 'archived') return raw;
      throw new ConsoleError('VALIDATION_FAILED', 'status 必须是 serving / paused / archived');
    };

    const parseConsent = (raw: unknown): Patient['consent'] => {
      if (raw === 'agreed' || raw === 'unknown' || raw === 'disagreed') return raw;
      throw new ConsoleError('VALIDATION_FAILED', 'consent 必须是 agreed / unknown / disagreed');
    };

    /** 工作台「最近服务动态」的口径：只区分已核验/改后发送/发错群/未核验，其余为待核验。 */
    const recentOutcome = (
      status: Draft['status'],
    ): 'verified' | 'edit_sent' | 'misroute' | 'unverified' | 'pending' => {
      if (status === 'VERIFIED') return 'verified';
      if (status === 'EDIT_SENT') return 'edit_sent';
      if (status === 'MISROUTE_ALERT') return 'misroute';
      if (status === 'UNVERIFIED') return 'unverified';
      return 'pending';
    };

    const ARCHIVE_MEDIA_TYPES: Record<string, string> = {      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      amr: 'audio/amr',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      pdf: 'application/pdf',
      txt: 'text/plain; charset=utf-8',
    };

    const mediaContentType = (path: string): string => {
      const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
      return (extension && ARCHIVE_MEDIA_TYPES[extension]) || 'application/octet-stream';
    };

    /** 只允许读取草稿登记过的存档媒体路径，避免借 mediaId 读取任意文件。 */
    const archiveMediaFile = (mediaId: string): string | undefined => {
      const path = decodeArchiveMediaId(mediaId);
      if (!path) return undefined;
      const known = consoleDrafts().some((draft) =>
        (draft.mediaIds ?? []).some((item) => item === path),
      );
      return known ? path : undefined;
    };

    const mapMemoryError = (error: unknown): never => {
      const message = error instanceof Error ? error.message : String(error);
      const [code, ...rest] = message.split(': ');
      if (code === 'NOT_FOUND') throw new ConsoleError('NOT_FOUND', '记忆不存在');
      throw new ConsoleError('VALIDATION_FAILED', rest.join(': ') || message);
    };

    const mapCareError = (error: unknown): never => {
      const message = error instanceof Error ? error.message : String(error);
      const [code, ...rest] = message.split(': ');
      if (code === 'NOT_FOUND') throw new ConsoleError('NOT_FOUND', '计划不存在');
      if (code === 'IMMUTABLE_RESOURCE') {
        throw new ConsoleError('IMMUTABLE_RESOURCE', '已执行的计划不能取消');
      }
      throw new ConsoleError('VALIDATION_FAILED', rest.join(': ') || message);
    };

    // -- 工作台 --

    router.add(
      'GET',
      '/dashboard/value',
      (rc) => {
        tenantActor(rc);
        const range = parseDashboardRange(rc.query.get('range'));
        const lookups = consoleLookups();
        respond(
          rc,
          200,
          dashboardValue({
            range,
            now: nowMs(),
            timeZone: auth.tenant.timezone,
            minutesPerDraft: auth.tenant.settings.writeMinutesPerDraft,
            drafts: consoleDrafts(),
            patients: lookups.patients,
            advisors: lookups.advisors,
            carePlans: consoleCarePlans(),
          }),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'GET',
      '/dashboard/kpis',
      (rc) => {
        tenantActor(rc);
        const range = parseDashboardRange(rc.query.get('range'));
        respond(
          rc,
          200,
          dashboardKpis({
            range,
            now: nowMs(),
            timeZone: auth.tenant.timezone,
            drafts: consoleDrafts(),
            advisors: patientReadApi()?.listAdvisors?.() ?? [],
            memories: consoleMemories(),
            openAlerts: alerts.unresolvedCount().open,
          }),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'GET',
      '/dashboard/recent',
      (rc) => {
        tenantActor(rc);
        const limit = Math.min(20, positiveInt(rc.query.get('limit'), 10));
        const lookups = consoleLookups();
        const items = consoleDrafts()
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
          .map((draft) => {
            const row = serviceFlowRow(draft, lookups);
            return {
              id: row.id,
              patientName: row.patientName,
              advisorName: row.advisorName,
              groupName: row.groupName,
              preview: row.summary,
              outcome: recentOutcome(draft.status),
              at: row.createdAt,
              sandbox: false,
            };
          });
        respond(rc, 200, { items });
      },
      { permission: 'patient.read' },
    );

    // -- 患者 --

    router.add(
      'POST',
      '/patients',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = patientReadApi();
        if (!api?.createPatient) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
        const body = await rc.json<Record<string, unknown>>();
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        if (!displayName) throw new ConsoleError('VALIDATION_FAILED', '患者备注名不能为空');
        let tags: string[] | undefined;
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || body.tags.some((item) => typeof item !== 'string')) {
            throw new ConsoleError('VALIDATION_FAILED', 'tags 必须是字符串数组');
          }
          tags = body.tags as string[];
        }
        const consent = body.consent === undefined ? undefined : parseConsent(body.consent);
        let created: Patient;
        try {
          created = api.createPatient({ displayName, tags, consent });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('ADVISOR_NOT_FOUND')) {
            throw new ConsoleError('VALIDATION_FAILED', '顾问不存在');
          }
          throw error;
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'patient.create', 'patient', created.id),
        );
        respond(
          rc,
          201,
          patientView(created, {
            groupIds: [],
            advisorId: created.advisorId,
            memoryCount: 0,
            pendingPlanCount: 0,
          }),
        );
      },
      { permission: 'patient.write' },
    );

    router.add(
      'POST',
      '/groups/:id/bindings',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = patientReadApi();
        if (!api?.bindPatient) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
        const groupId = rc.params.id!;
        const group = api.listGroups?.().find((item) => item.id === groupId);
        if (!group) throw new ConsoleError('NOT_FOUND', '群不存在');
        const body = await rc.json<Record<string, unknown>>();
        let patientId: string;
        if (typeof body.patientId === 'string' && body.patientId.trim() !== '') {
          patientId = body.patientId.trim();
        } else if (body.newPatient && typeof body.newPatient === 'object') {
          if (!api.createPatient) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
          const input = body.newPatient as Record<string, unknown>;
          const displayName =
            typeof input.displayName === 'string' ? input.displayName.trim() : '';
          if (!displayName) throw new ConsoleError('VALIDATION_FAILED', '患者备注名不能为空');
          const tags = Array.isArray(input.tags)
            ? (input.tags as unknown[]).filter((item): item is string => typeof item === 'string')
            : undefined;
          const consent = input.consent === undefined ? undefined : parseConsent(input.consent);
          patientId = api.createPatient({ displayName, tags, consent }).id;
        } else {
          throw new ConsoleError('VALIDATION_FAILED', '需要 patientId 或 newPatient');
        }
        let binding: GroupBinding;
        try {
          binding = api.bindPatient(groupId, patientId, (group.patientIds?.length ?? 0) === 0);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('PATIENT_NOT_FOUND')) {
            throw new ConsoleError('NOT_FOUND', '患者不存在');
          }
          if (message.startsWith('GROUP_NOT_FOUND')) {
            throw new ConsoleError('NOT_FOUND', '群不存在');
          }
          throw error;
        }
        const patient =
          api.getPatientAdmin?.(patientId) ??
          api.listPatients?.().find((item) => item.id === patientId);
        if (!patient) throw new ConsoleError('NOT_FOUND', '患者不存在');
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'group.bind', 'group', groupId, { patientId }),
        );
        const lookups = consoleLookups();
        respond(rc, 201, {
          binding: {
            id: binding.id,
            tenantId: binding.tenantId,
            groupId: binding.groupId,
            patientId: binding.patientId,
            isPrimary: binding.isPrimary,
            createdAt: binding.createdAt,
            deletedAt: binding.deletedAt ?? null,
          },
          patient: patientView(patient, {
            groupIds: lookups.bindings
              .filter((item) => item.patientId === patient.id)
              .map((item) => item.groupId),
            advisorId: patientAdvisorId(patient, lookups.groups, lookups.bindings),
            memoryCount: consoleMemoryCount(patient.id),
            pendingPlanCount: consolePendingPlans(patient.id),
          }),
        });
      },
      { permission: 'patient.write' },
    );

    router.add(
      'GET',
      '/patients',
      (rc) => {
        tenantActor(rc);
        const lookups = consoleLookups();
        const q = rc.query.get('q')?.trim().toLowerCase();
        const tag = rc.query.get('tag');
        const advisorId = rc.query.get('advisorId');
        const consent = rc.query.get('consent');
        const status = rc.query.get('status');
        const demo = rc.query.get('demo');
        let items = lookups.patients.map((patient) => {
          const groupIds = lookups.bindings
            .filter((binding) => binding.patientId === patient.id)
            .map((binding) => binding.groupId);
          return patientView(patient, {
            groupIds,
            advisorId: patientAdvisorId(patient, lookups.groups, lookups.bindings),
            memoryCount: consoleMemoryCount(patient.id),
            pendingPlanCount: consolePendingPlans(patient.id),
          });
        });
        if (q) {
          items = items.filter(
            (item) =>
              item.displayName.toLowerCase().includes(q) ||
              item.tags.some((itemTag) => itemTag.toLowerCase().includes(q)),
          );
        }
        if (tag) items = items.filter((item) => item.tags.includes(tag));
        if (advisorId) items = items.filter((item) => item.advisorId === advisorId);
        if (consent) items = items.filter((item) => item.consent === consent);
        if (status) items = items.filter((item) => item.status === status);
        if (demo === 'true' || demo === 'false') {
          items = items.filter((item) => item.demo === (demo === 'true'));
        }
        const sort = rc.query.get('sort') ?? '-lastActiveAt';
        const desc = sort.startsWith('-');
        const key = desc ? sort.slice(1) : sort;
        if (!['lastActiveAt', 'name', 'createdAt', 'updatedAt'].includes(key)) {
          throw new ConsoleError('VALIDATION_FAILED', 'sort 必须是 lastActiveAt / name / createdAt / updatedAt');
        }
        items.sort((a, b) => {
          const left = key === 'name' ? a.displayName : key === 'createdAt' ? a.createdAt : key === 'updatedAt' ? a.updatedAt : (a.lastActiveAt ?? 0);
          const right = key === 'name' ? b.displayName : key === 'createdAt' ? b.createdAt : key === 'updatedAt' ? b.updatedAt : (b.lastActiveAt ?? 0);
          const compared =
            typeof left === 'string' && typeof right === 'string'
              ? left.localeCompare(right, 'zh-CN')
              : Number(left) - Number(right);
          return desc ? -compared : compared;
        });
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'GET',
      '/patients/:id',
      (rc) => {
        tenantActor(rc);
        const patient = requirePatient(rc.params.id!);
        const lookups = consoleLookups();
        const api = patientReadApi();
        const groupIds = lookups.bindings
          .filter((binding) => binding.patientId === patient.id)
          .map((binding) => binding.groupId);
        const advisorId = patientAdvisorId(patient, lookups.groups, lookups.bindings);
        const advisor = advisorId ? lookups.advisors.find((item) => item.id === advisorId) : undefined;
        const groups = (api?.getPatientGroups?.(patient.id)?.groups ?? []).map((group) => ({
          id: group.id,
          name: group.name,
          status: group.status ?? 'serving',
          isPrimary: group.isPrimary ?? false,
        }));
        respond(rc, 200, {
          patient: patientView(patient, {
            groupIds,
            advisorId,
            memoryCount: consoleMemoryCount(patient.id),
            pendingPlanCount: consolePendingPlans(patient.id),
          }),
          advisor: advisor
            ? {
                id: advisor.id,
                name: advisor.name,
                status: advisor.status,
                online: advisor.status === 'active',
              }
            : null,
          groups,
        });
      },
      { permission: 'patient.read' },
    );

    router.add(
      'PATCH',
      '/patients/:id',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = patientReadApi();
        if (!api?.updatePatient) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
        const patient = requirePatient(rc.params.id!);
        const body = await rc.json<Record<string, unknown>>();
        const patch: Parameters<NonNullable<PatientApiLike['updatePatient']>>[1] = {};
        if (body.displayName !== undefined) {
          if (typeof body.displayName !== 'string' || body.displayName.trim() === '') {
            throw new ConsoleError('VALIDATION_FAILED', '备注名不能为空');
          }
          patch.displayName = body.displayName.trim();
        }
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || body.tags.some((item) => typeof item !== 'string')) {
            throw new ConsoleError('VALIDATION_FAILED', 'tags 必须是字符串数组');
          }
          patch.tags = body.tags as string[];
        }
        if (body.consent !== undefined) patch.consent = parseConsent(body.consent);
        if (body.status !== undefined) patch.status = parsePatientStatus(body.status);
        if (body.advisorId !== undefined) {
          if (typeof body.advisorId !== 'string' || body.advisorId.trim() === '') {
            throw new ConsoleError('VALIDATION_FAILED', 'advisorId 必须是非空字符串');
          }
          if (!api.listAdvisors?.().some((advisor) => advisor.id === body.advisorId)) {
            throw new ConsoleError('VALIDATION_FAILED', '顾问不存在');
          }
          patch.advisorId = body.advisorId;
        }
        if (body.avatar === null) patch.avatar = undefined;
        else if (typeof body.avatar === 'string') patch.avatar = body.avatar;
        if (body.externalUserId !== undefined) {
          if (typeof body.externalUserId !== 'string' || body.externalUserId.trim() === '') {
            throw new ConsoleError('VALIDATION_FAILED', 'externalUserId 必须是非空字符串');
          }
          patch.externalUserId = body.externalUserId;
        }
        if (Object.keys(patch).length === 0) {
          throw new ConsoleError('VALIDATION_FAILED', '至少提供一个可更新字段');
        }
        let updated: Patient;
        try {
          updated = api.updatePatient(patient.id, patch);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('PATIENT_NOT_FOUND')) throw new ConsoleError('NOT_FOUND', '患者不存在');
          if (message.startsWith('ADVISOR_NOT_FOUND')) throw new ConsoleError('VALIDATION_FAILED', '顾问不存在');
          throw error;
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'patient.update', 'patient', updated.id, {
            fields: Object.keys(patch),
          }),
        );
        const lookups = consoleLookups();
        respond(
          rc,
          200,
          patientView(updated, {
            groupIds: lookups.bindings
              .filter((binding) => binding.patientId === updated.id)
              .map((binding) => binding.groupId),
            advisorId: patientAdvisorId(updated, lookups.groups, lookups.bindings),
            memoryCount: consoleMemoryCount(updated.id),
            pendingPlanCount: consolePendingPlans(updated.id),
          }),
        );
      },
      { permission: 'patient.write' },
    );

    // 确认 / 改绑患者身份：把患者指向服务群里的一位外部成员
    router.add(
      'POST',
      '/patients/:id/identity',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = patientReadApi();
        if (!api?.setPatientIdentity) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '患者域未就绪');
        const patient = requirePatient(rc.params.id!);
        const body = await rc.json<Record<string, unknown>>();
        const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
        const externalUserId =
          typeof body.externalUserId === 'string' ? body.externalUserId.trim() : '';
        if (!groupId) throw new ConsoleError('VALIDATION_FAILED', 'groupId 不能为空');
        if (!externalUserId) {
          throw new ConsoleError('VALIDATION_FAILED', 'externalUserId 不能为空');
        }
        if (body.displayName !== undefined && typeof body.displayName !== 'string') {
          throw new ConsoleError('VALIDATION_FAILED', 'displayName 必须是字符串');
        }
        const opts: { displayName?: string } =
          typeof body.displayName === 'string' && body.displayName.trim() !== ''
            ? { displayName: body.displayName.trim() }
            : {};
        let updated: Patient;
        try {
          updated = api.setPatientIdentity(groupId, patient.id, externalUserId, opts);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('NOT_BOUND')) {
            throw new ConsoleError('VALIDATION_FAILED', '患者未绑定该服务群');
          }
          if (message.startsWith('MEMBER_NOT_EXTERNAL')) {
            throw new ConsoleError('VALIDATION_FAILED', '该成员不是服务群的外部成员');
          }
          if (message.startsWith('PATIENT_NOT_FOUND')) throw new ConsoleError('NOT_FOUND', '患者不存在');
          if (message.startsWith('GROUP_NOT_FOUND')) throw new ConsoleError('NOT_FOUND', '群不存在');
          throw error;
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'patient.identity', 'patient', updated.id, {
            groupId,
          }),
        );
        const lookups = consoleLookups();
        respond(
          rc,
          200,
          patientView(updated, {
            groupIds: lookups.bindings
              .filter((binding) => binding.patientId === updated.id)
              .map((binding) => binding.groupId),
            advisorId: patientAdvisorId(updated, lookups.groups, lookups.bindings),
            memoryCount: consoleMemoryCount(updated.id),
            pendingPlanCount: consolePendingPlans(updated.id),
          }),
        );
      },
      { permission: 'patient.write' },
    );

    // -- 记忆 --

    router.add(
      'GET',
      '/patients/:id/memories',
      (rc) => {
        tenantActor(rc);
        const patient = requirePatient(rc.params.id!);
        const category = rc.query.get('category') ?? undefined;
        const includeDeleted = rc.query.get('includeDeleted') === 'true';
        const items = (memoryReadApi()?.list(patient.id, { category, includeDeleted }) ?? []) as MemoryRecord[];
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 50)),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'POST',
      '/patients/:id/memories',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = memoryReadApi();
        if (!api?.write) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '记忆域未就绪');
        const patient = requirePatient(rc.params.id!);
        const body = await rc.json<Record<string, unknown>>();
        let memory: unknown;
        try {
          memory = api.write({
            patientId: patient.id,
            category: body.category,
            content: body.content,
            subject: body.subject,
            sourceText: body.sourceText,
            sourceMsgId: body.sourceMsgId,
            createdBy: 'staff',
            createdById: actor.account.id,
          });
        } catch (error) {
          mapMemoryError(error);
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'memory.create', 'memory', (memory as { id?: string }).id ?? null),
        );
        respond(rc, 201, memory);
      },
      { permission: 'patient.write' },
    );

    router.add(
      'PATCH',
      '/memories/:id',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = memoryReadApi();
        if (!api?.update) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '记忆域未就绪');
        const body = await rc.json<Record<string, unknown>>();
        let memory: unknown;
        try {
          memory = api.update(rc.params.id!, body, 'staff', actor.account.id);
        } catch (error) {
          mapMemoryError(error);
        }
        store.appendAudit(auditRecord(config.tenantId, actor, 'memory.update', 'memory', rc.params.id!));
        respond(rc, 200, memory);
      },
      { permission: 'patient.write' },
    );

    router.add(
      'DELETE',
      '/memories/:id',
      (rc) => {
        const actor = tenantActor(rc);
        const api = memoryReadApi();
        if (!api?.remove) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '记忆域未就绪');
        try {
          api.remove(rc.params.id!, 'staff', actor.account.id);
        } catch (error) {
          mapMemoryError(error);
        }
        store.appendAudit(auditRecord(config.tenantId, actor, 'memory.delete', 'memory', rc.params.id!));
        emptyResponse(rc.res, 204, rc.requestId);
      },
      { permission: 'patient.write' },
    );

    // -- 主动计划 --

    router.add(
      'GET',
      '/patients/:id/care-plans',
      (rc) => {
        tenantActor(rc);
        const patient = requirePatient(rc.params.id!);
        const status = rc.query.get('status') ?? undefined;
        const items = (careReadApi()?.list(patient.id, status) ?? []) as CarePlanRecord[];
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'POST',
      '/patients/:id/care-plans',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = careReadApi();
        if (!api?.create) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '主动计划域未就绪');
        const patient = requirePatient(rc.params.id!);
        const body = await rc.json<Record<string, unknown>>();
        let plan: unknown;
        try {
          plan = api.create({
            patientId: patient.id,
            title: body.title,
            when: body.when,
            rrule: body.rrule ?? null,
            source: 'staff',
          });
        } catch (error) {
          mapCareError(error);
        }
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'care_plan.create', 'care_plan', (plan as { id?: string }).id ?? null),
        );
        respond(rc, 201, plan);
      },
      { permission: 'patient.write' },
    );

    router.add(
      'POST',
      '/care-plans/:id/cancel',
      (rc) => {
        const actor = tenantActor(rc);
        const api = careReadApi();
        if (!api?.cancel) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '主动计划域未就绪');
        let plan: unknown;
        try {
          plan = api.cancel(rc.params.id!, 'staff');
        } catch (error) {
          mapCareError(error);
        }
        store.appendAudit(auditRecord(config.tenantId, actor, 'care_plan.cancel', 'care_plan', rc.params.id!));
        respond(rc, 200, plan);
      },
      { permission: 'patient.write' },
    );

    // -- 办事记录 / 时间线 --

    router.add(
      'GET',
      '/patients/:id/actions',
      (rc) => {
        tenantActor(rc);
        const patient = requirePatient(rc.params.id!);
        const lookups = consoleLookups();
        const drafts = consoleDrafts().filter(
          (draft) => draftPatient(draft, lookups)?.id === patient.id,
        );
        const memories = (memoryReadApi()?.list(patient.id) ?? []) as MemoryRecord[];
        const carePlans = (careReadApi()?.list(patient.id) ?? []) as CarePlanRecord[];
        const items = buildPatientActions({
          patient,
          tenantId: config.tenantId,
          drafts,
          carePlans,
          memories,
        });
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'GET',
      '/patients/:id/timeline',
      (rc) => {
        tenantActor(rc);
        const patient = requirePatient(rc.params.id!);
        const lookups = consoleLookups();
        const drafts = consoleDrafts().filter(
          (draft) => draftPatient(draft, lookups)?.id === patient.id,
        );
        const items = buildPatientTimeline({
          patient,
          drafts,
          memories: (memoryReadApi()?.list(patient.id) ?? []) as MemoryRecord[],
          carePlans: (careReadApi()?.list(patient.id) ?? []) as CarePlanRecord[],
          alerts: alerts.list({ patientId: patient.id }).items.map((alert) => ({
            id: alert.id,
            title: alert.title,
            message: alert.message,
            createdAt: alert.createdAt,
          })),
        });
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'patient.read' },
    );

    // -- B 档：真实健康档案 / 服务计划暂未接入，按契约返回空 --

    router.add(
      'GET',
      '/patients/:id/health-profile',
      (rc) => {
        tenantActor(rc);
        requirePatient(rc.params.id!);
        respond(rc, 200, { profile: null, sample: true });
      },
      { permission: 'patient.read' },
    );

    router.add(
      'GET',
      '/patients/:id/service-plan',
      (rc) => {
        tenantActor(rc);
        requirePatient(rc.params.id!);
        respond(rc, 200, { plan: null, sample: true });
      },
      { permission: 'patient.read' },
    );

    // -- 顾问 --

    router.add(
      'GET',
      '/advisors',
      (rc) => {
        tenantActor(rc);
        const status = rc.query.get('status');
        if (status && !['active', 'paused', 'left'].includes(status)) {
          throw new ConsoleError('VALIDATION_FAILED', 'status 必须是 active / paused / left');
        }
        const drafts = consoleDrafts();
        const items = (patientReadApi()?.listAdvisors?.() ?? [])
          .filter((advisor) => (status ? advisor.status === status : true))
          .map((advisor) =>
            advisorView(
              advisor,
              drafts.filter(
                (draft) => draft.advisorId === advisor.id && draft.status === 'QUEUED',
              ).length,
            ),
          );
        respond(
          rc,
          200,
          paginate(items, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'patient.read' },
    );

    router.add(
      'POST',
      '/advisors/:id/pause',
      async (rc) => {
        const actor = tenantActor(rc);
        const api = patientReadApi();
        const wecom = wecomReadApi();
        if (!api?.getAdvisor || !wecom?.pauseAdvisor) {
          throw new ConsoleError('UPSTREAM_UNAVAILABLE', '顾问域未就绪');
        }
        const advisor = api.getAdvisor(rc.params.id!);
        if (!advisor) throw new ConsoleError('NOT_FOUND', '顾问不存在');
        if (advisor.status === 'left') throw new ConsoleError('CONFLICT', '已离职顾问不能暂停');
        const paused = wecom.pauseAdvisor(advisor.id);
        if (!paused) throw new ConsoleError('NOT_FOUND', '顾问不存在');
        const updated = api.updateAdvisor?.(advisor.id, { status: 'paused' }) ?? advisor;
        const body = await rc.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'advisor.pause', 'advisor', advisor.id, {
            reason: typeof body.reason === 'string' ? body.reason : null,
          }),
        );
        respond(rc, 200, advisorView(updated, consoleDrafts().filter(
          (draft) => draft.advisorId === advisor.id && draft.status === 'QUEUED',
        ).length));
      },
      { permission: 'advisor.operate' },
    );

    router.add(
      'POST',
      '/advisors/:id/resume',
      (rc) => {
        const actor = tenantActor(rc);
        const api = patientReadApi();
        const wecom = wecomReadApi();
        if (!api?.getAdvisor || !wecom?.restoreAdvisor) {
          throw new ConsoleError('UPSTREAM_UNAVAILABLE', '顾问域未就绪');
        }
        const advisor = api.getAdvisor(rc.params.id!);
        if (!advisor) throw new ConsoleError('NOT_FOUND', '顾问不存在');
        if (advisor.status === 'left') throw new ConsoleError('CONFLICT', '已离职顾问不能恢复');
        wecom.restoreAdvisor(advisor.id, actor.account.id);
        const updated = api.updateAdvisor?.(advisor.id, { status: 'active' }) ?? advisor;
        store.appendAudit(auditRecord(config.tenantId, actor, 'advisor.resume', 'advisor', advisor.id));
        respond(rc, 200, advisorView(updated, consoleDrafts().filter(
          (draft) => draft.advisorId === advisor.id && draft.status === 'QUEUED',
        ).length));
      },
      { permission: 'advisor.operate' },
    );

    router.add(
      'POST',
      '/advisors/:id/queue/release',
      async (rc) => {
        const actor = tenantActor(rc);
        const wecom = wecomReadApi();
        if (!wecom?.releaseQueue) throw new ConsoleError('UPSTREAM_UNAVAILABLE', '企微域未就绪');
        const result = await wecom.releaseQueue(rc.params.id!, actor.account.id);
        store.appendAudit(
          auditRecord(config.tenantId, actor, 'advisor.queue.release', 'advisor', rc.params.id!, {
            releasedDraftId: result.releasedDraftId,
            nextDraftId: result.nextDraftId,
          }),
        );
        respond(rc, 200, result);
      },
      { permission: 'advisor.operate' },
    );

    // -- 服务流 --

    router.add(
      'GET',
      '/service-flow',
      (rc) => {
        tenantActor(rc);
        const lookups = consoleLookups();
        const groupId = rc.query.get('groupId');
        const advisorId = rc.query.get('advisorId');
        const patientId = rc.query.get('patientId');
        const status = rc.query.get('status');
        const riskLevel = rc.query.get('riskLevel');
        const source = rc.query.get('source');
        const fallback = rc.query.get('fallback');
        const from = parseTime(rc.query.get('from'), 'from');
        const to = parseTime(rc.query.get('to'), 'to');
        let rows = consoleDrafts().map((draft) => serviceFlowRow(draft, lookups));
        if (groupId) rows = rows.filter((row) => row.groupId === groupId);
        if (advisorId) rows = rows.filter((row) => row.advisorId === advisorId);
        if (patientId) rows = rows.filter((row) => row.patientId === patientId);
        if (status) {
          const allowed = status.split(',').filter(Boolean);
          rows = rows.filter((row) => allowed.includes(row.status));
        }
        if (riskLevel) rows = rows.filter((row) => row.riskLevel === riskLevel);
        if (source) rows = rows.filter((row) => row.source === source);
        if (fallback === 'true' || fallback === 'false') {
          rows = rows.filter((row) => row.fallback === (fallback === 'true'));
        }
        if (from !== undefined) rows = rows.filter((row) => row.createdAt >= from);
        if (to !== undefined) rows = rows.filter((row) => row.createdAt <= to);
        rows.sort((a, b) => b.createdAt - a.createdAt);
        respond(
          rc,
          200,
          paginate(rows, positiveInt(rc.query.get('page'), 1), positiveInt(rc.query.get('pageSize'), 20)),
        );
      },
      { permission: 'draft.read' },
    );

    router.add(
      'GET',
      '/service-flow/:id',
      async (rc) => {
        tenantActor(rc);
        const wecom = wecomReadApi();
        const draft = wecom?.getDraftDetail?.(rc.params.id!);
        if (!draft) throw new ConsoleError('NOT_FOUND', '草稿不存在');
        const lookups = consoleLookups();
        const evidence = (await wecom?.getDraftEvidence?.(draft.id)) as
          | { sent?: { msgid: string; text: string; msgtime: number } | null }
          | undefined;
        const memoryApi = memoryReadApi();
        const knowledgeApi = knowledgeReadApi();
        const detail = serviceFlowDetail(draft, {
          ...lookups,
          evidence: { sent: evidence?.sent ?? null },
          memories: (draft.citedMemoryIds ?? [])
            .map((id) => memoryApi?.get?.(id))
            .filter((item): item is Record<string, unknown> => Boolean(item)) as unknown as MemoryRecord[],
          knowledge: (draft.citedKnowledgeIds ?? [])
            .map((id) => knowledgeApi?.get?.(id))
            .filter((item): item is { id: string; title: string; deletedAt?: number } => Boolean(item)),
          audits: wecom?.listAudits?.() ?? [],
        });
        detail.media = detail.media.map((item) => ({
          ...item,
          url: `${API_PREFIX}/media/${item.id}`,
        }));
        respond(rc, 200, detail);
      },
      { permission: 'draft.read' },
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
        const archivePath = archiveMediaFile(rc.params.mediaId!);
        if (archivePath) {
          let data: Buffer;
          try {
            data = await readFile(archivePath);
          } catch {
            throw new ConsoleError('NOT_FOUND', '媒体文件不存在');
          }
          rc.res.writeHead(200, {
            'content-type': mediaContentType(archivePath),
            'content-length': data.length,
            'cache-control': 'private, max-age=300',
            'x-request-id': rc.requestId,
          });
          rc.res.end(data);
          return;
        }
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
