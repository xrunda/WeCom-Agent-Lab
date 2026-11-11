/**
 * WP-H / #119 风险规则控制台接口（docs/P1-api.md §10）。
 *
 * 规则存储、校验与命中判定都在 `zhiban-guard`；控制台只做权限、错误码映射与审计。
 * 租户侧只能维护关键词规则，四条内置红线只读。
 */
import { ConsoleError } from '../../../src/p1/console-error.ts';
import type {
  RiskRuleCreateInput,
  RiskRuleRecord,
  RiskRuleUpdateInput,
} from '../../../src/p1/guard.ts';
import type { RiskLevel } from '../../../src/c2/types.ts';
import type { AuthActor } from '../auth.ts';
import { emptyResponse, jsonResponse } from '../http.ts';
import type { RouteContext, Router } from '../http.ts';

export interface GuardRulesApi {
  listRules?(query?: { kind?: 'redline' | 'keyword'; enabled?: boolean }): RiskRuleRecord[];
  getRule?(id: string): RiskRuleRecord | undefined;
  createRule?(input: RiskRuleCreateInput): RiskRuleRecord;
  updateRule?(id: string, patch: RiskRuleUpdateInput): RiskRuleRecord;
  deleteRule?(id: string): void;
}

export interface RiskRuleAuditDetail {
  ruleId: string;
  kind: 'redline' | 'keyword';
  name: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

export interface RiskRuleRouteDeps {
  router: Router;
  getGuard: () => GuardRulesApi | undefined;
  tenantActor: (rc: RouteContext) => AuthActor;
  audit: (
    actor: AuthActor,
    action: 'rule.created' | 'rule.updated' | 'rule.deleted',
    detail: RiskRuleAuditDetail,
  ) => void;
}

const NAME_MAX = 40;
const KEYWORDS_MAX = 20;
const KEYWORD_MAX = 30;
const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high'];
const ACTIONS = ['flag', 'guide', 'escalate'] as const;

type RuleAction = (typeof ACTIONS)[number];

const GUARD_VALIDATION_CODES = new Set([
  'EMPTY_NAME',
  'NAME_TOO_LONG',
  'EMPTY_KEYWORDS',
  'TOO_MANY_KEYWORDS',
  'INVALID_KEYWORD',
  'INVALID_RISK_LEVEL',
  'INVALID_ACTION',
  'INVALID_KIND',
]);

function mapGuardError(error: unknown, builtinMessage: string): never {
  if (error instanceof ConsoleError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const [code, ...rest] = message.split(': ');
  if (code === 'NOT_FOUND') throw new ConsoleError('NOT_FOUND', '规则不存在');
  if (code === 'IMMUTABLE_RESOURCE') throw new ConsoleError('BUILTIN_RULE', builtinMessage);
  if (code !== undefined && GUARD_VALIDATION_CODES.has(code)) {
    throw new ConsoleError('VALIDATION_FAILED', rest.join(': ') || message);
  }
  throw error;
}

function requireApi(api: GuardRulesApi | undefined): Required<GuardRulesApi> {
  if (!api?.listRules || !api.getRule || !api.createRule || !api.updateRule || !api.deleteRule) {
    throw new ConsoleError('UPSTREAM_UNAVAILABLE', '风险规则未就绪');
  }
  return api as Required<GuardRulesApi>;
}

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConsoleError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 不能为空`);
  }
  const text = value.trim();
  if (text.length > NAME_MAX) {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 不能超过 ${NAME_MAX} 字`);
  }
  return text;
}

function stringArrayField(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 至少一个`);
  }
  if (value.length > KEYWORDS_MAX) {
    throw new ConsoleError('VALIDATION_FAILED', `${field} 最多 ${KEYWORDS_MAX} 个`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ConsoleError('VALIDATION_FAILED', `${field} 必须是字符串数组`);
    }
    const keyword = item.trim();
    if (keyword === '' || keyword.length > KEYWORD_MAX) {
      throw new ConsoleError('VALIDATION_FAILED', `关键词长度需为 1–${KEYWORD_MAX} 字`);
    }
    if (!result.includes(keyword)) result.push(keyword);
  }
  return result;
}

function riskLevelField(body: Record<string, unknown>, required: boolean): RiskLevel | undefined {
  const value = body.riskLevel;
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !(RISK_LEVELS as readonly string[]).includes(value)) {
    throw new ConsoleError('VALIDATION_FAILED', 'riskLevel 必须是 low/medium/high');
  }
  return value as RiskLevel;
}

function actionField(body: Record<string, unknown>, required: boolean): RuleAction | undefined {
  const value = body.action;
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !(ACTIONS as readonly string[]).includes(value)) {
    throw new ConsoleError('VALIDATION_FAILED', 'action 必须是 flag/guide/escalate');
  }
  return value as RuleAction;
}

function enabledField(body: Record<string, unknown>): boolean | undefined {
  const value = body.enabled;
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConsoleError('VALIDATION_FAILED', 'enabled 必须是布尔值');
  }
  return value;
}

function requireRule(api: Required<GuardRulesApi>, id: string): RiskRuleRecord {
  const rule = api.getRule(id);
  if (!rule) throw new ConsoleError('NOT_FOUND', '规则不存在');
  return rule;
}

function assertEditable(rule: RiskRuleRecord): void {
  if (rule.builtin) {
    throw new ConsoleError('BUILTIN_RULE', '内置红线规则只读，不能修改');
  }
}

export function registerRiskRuleRoutes(deps: RiskRuleRouteDeps): void {
  const { router, tenantActor, audit } = deps;

  router.add(
    'GET',
    '/risk-rules',
    (rc) => {
      tenantActor(rc);
      const api = requireApi(deps.getGuard());
      const kindRaw = rc.query.get('kind');
      if (kindRaw !== null && kindRaw !== '' && kindRaw !== 'redline' && kindRaw !== 'keyword') {
        throw new ConsoleError('VALIDATION_FAILED', 'kind 必须是 redline 或 keyword');
      }
      const enabledRaw = rc.query.get('enabled');
      let enabled: boolean | undefined;
      if (enabledRaw !== null && enabledRaw !== '') {
        if (enabledRaw !== 'true' && enabledRaw !== 'false') {
          throw new ConsoleError('VALIDATION_FAILED', 'enabled 必须是 true 或 false');
        }
        enabled = enabledRaw === 'true';
      }
      const items = api.listRules({
        kind: kindRaw === 'redline' || kindRaw === 'keyword' ? kindRaw : undefined,
        enabled,
      });
      jsonResponse(rc.res, 200, { items, total: items.length }, rc.requestId);
    },
    { permission: 'tenant.read' },
  );

  router.add(
    'POST',
    '/risk-rules',
    async (rc) => {
      const actor = tenantActor(rc);
      const api = requireApi(deps.getGuard());
      const body = assertObject(await rc.json<unknown>());
      if (body.kind !== undefined && body.kind !== 'keyword') {
        throw new ConsoleError('VALIDATION_FAILED', '内置红线只读，只能创建关键词规则', [
          { field: 'kind', issue: 'redline 由平台内置且不可创建' },
        ]);
      }
      let rule: RiskRuleRecord;
      try {
        rule = api.createRule({
          name: stringField(body, 'name'),
          keywords: stringArrayField(body, 'keywords'),
          riskLevel: riskLevelField(body, true)!,
          action: actionField(body, false),
          enabled: enabledField(body),
        });
      } catch (error) {
        mapGuardError(error, '内置红线规则只读');
      }
      audit(actor, 'rule.created', {
        ruleId: rule.id,
        kind: rule.kind,
        name: rule.name,
        changes: { enabled: { from: null, to: rule.enabled } },
      });
      jsonResponse(rc.res, 201, rule, rc.requestId);
    },
    { permission: 'tenant.write' },
  );

  router.add(
    'PATCH',
    '/risk-rules/:id',
    async (rc) => {
      const actor = tenantActor(rc);
      const api = requireApi(deps.getGuard());
      const before = requireRule(api, rc.params.id!);
      assertEditable(before);
      const body = assertObject(await rc.json<unknown>());
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const patch: RiskRuleUpdateInput = {};
      if (body.name !== undefined) {
        patch.name = stringField(body, 'name');
        if (patch.name !== before.name) changes.name = { from: before.name, to: patch.name };
      }
      if (body.keywords !== undefined) patch.keywords = stringArrayField(body, 'keywords');
      if (body.riskLevel !== undefined) patch.riskLevel = riskLevelField(body, true);
      if (body.action !== undefined) patch.action = actionField(body, true);
      if (body.enabled !== undefined) {
        patch.enabled = enabledField(body);
        if (patch.enabled !== before.enabled) {
          changes.enabled = { from: before.enabled, to: patch.enabled };
        }
      }
      let rule: RiskRuleRecord;
      try {
        rule = api.updateRule(before.id, patch);
      } catch (error) {
        mapGuardError(error, '内置红线规则只读，不能修改');
      }
      audit(actor, 'rule.updated', {
        ruleId: rule.id,
        kind: rule.kind,
        name: rule.name,
        changes,
      });
      jsonResponse(rc.res, 200, rule, rc.requestId);
    },
    { permission: 'tenant.write' },
  );

  router.add(
    'DELETE',
    '/risk-rules/:id',
    (rc) => {
      const actor = tenantActor(rc);
      const api = requireApi(deps.getGuard());
      const rule = requireRule(api, rc.params.id!);
      assertEditable(rule);
      try {
        api.deleteRule(rule.id);
      } catch (error) {
        mapGuardError(error, '内置红线规则只读，不能删除');
      }
      audit(actor, 'rule.deleted', {
        ruleId: rule.id,
        kind: rule.kind,
        name: rule.name,
        changes: { enabled: { from: rule.enabled, to: false } },
      });
      emptyResponse(rc.res, 204, rc.requestId);
    },
    { permission: 'tenant.write' },
  );
}
