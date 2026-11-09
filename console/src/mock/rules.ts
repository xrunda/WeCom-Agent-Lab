import rulesFixture from './fixtures/risk-rules.json';
import tenantFixture from './fixtures/tenant.json';
import { ApiError, apiRequest, isMockMode } from './http.ts';
import { mockId, readStore, toQuery, writeStore } from './storage.ts';
import type { RiskAction, RiskLevel, RiskRule, RiskRuleKind, Tenant } from '../types.ts';

const STORE_KEY = 'zhiban.console.risk-rules';
const TENANT_ID = (tenantFixture as unknown as Tenant).id;

export interface RiskRuleListParams {
  kind?: RiskRuleKind;
  enabled?: boolean;
}

export interface RiskRuleInput {
  name: string;
  keywords: string[];
  riskLevel: RiskLevel;
  action: RiskAction;
  enabled?: boolean;
}

export type RiskRulePatch = Partial<RiskRuleInput>;

function load(): RiskRule[] {
  return readStore<RiskRule[]>(STORE_KEY, rulesFixture as unknown as RiskRule[]);
}

function save(items: RiskRule[]): void {
  writeStore(STORE_KEY, items);
}

function normalizeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))];
}

function validate(input: RiskRuleInput): void {
  if (!input.name.trim()) throw new ApiError('VALIDATION_FAILED', '请填写规则名称', 422);
  if (normalizeKeywords(input.keywords).length === 0) {
    throw new ApiError('VALIDATION_FAILED', '至少填写一个关键词', 422);
  }
}

/** GET /risk-rules */
export async function listRiskRules(
  params: RiskRuleListParams = {},
): Promise<{ items: RiskRule[]; total: number }> {
  if (!isMockMode) {
    return apiRequest(
      `/risk-rules${toQuery({ kind: params.kind, enabled: params.enabled })}`,
    );
  }

  let items = load();
  if (params.kind) items = items.filter((rule) => rule.kind === params.kind);
  if (params.enabled !== undefined) items = items.filter((rule) => rule.enabled === params.enabled);
  items = [...items].sort(
    (a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'redline' ? -1 : 1),
  );
  return { items, total: items.length };
}

/** POST /risk-rules：只能创建关键词规则 */
export async function createRiskRule(input: RiskRuleInput): Promise<RiskRule> {
  if (!isMockMode) {
    return apiRequest('/risk-rules', {
      method: 'POST',
      body: JSON.stringify({ ...input, kind: 'keyword' }),
    });
  }

  validate(input);
  const now = Date.now();
  const rule: RiskRule = {
    id: mockId('rul_kw'),
    tenantId: TENANT_ID,
    kind: 'keyword',
    name: input.name.trim(),
    keywords: normalizeKeywords(input.keywords),
    riskLevel: input.riskLevel,
    action: input.action,
    enabled: input.enabled ?? true,
    builtin: false,
    hitCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  save([...load(), rule]);
  return rule;
}

/** PATCH /risk-rules/{id}：内置规则只读 */
export async function updateRiskRule(id: string, patch: RiskRulePatch): Promise<RiskRule> {
  if (!isMockMode) {
    return apiRequest(`/risk-rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  const items = load();
  const index = items.findIndex((rule) => rule.id === id);
  if (index < 0) throw new ApiError('NOT_FOUND', '规则不存在', 404);
  if (items[index].builtin) {
    throw new ApiError('BUILTIN_RULE', '内置红线规则只读，不能修改', 409);
  }

  const next: RiskRule = {
    ...items[index],
    ...patch,
    name: patch.name?.trim() ?? items[index].name,
    keywords: patch.keywords ? normalizeKeywords(patch.keywords) : items[index].keywords,
    updatedAt: Date.now(),
  };
  if (!next.name) throw new ApiError('VALIDATION_FAILED', '请填写规则名称', 422);
  if (next.keywords.length === 0) {
    throw new ApiError('VALIDATION_FAILED', '至少填写一个关键词', 422);
  }
  items[index] = next;
  save(items);
  return next;
}

/** DELETE /risk-rules/{id}：内置规则只读 */
export async function deleteRiskRule(id: string): Promise<void> {
  if (!isMockMode) {
    await apiRequest<void>(`/risk-rules/${id}`, { method: 'DELETE' });
    return;
  }

  const items = load();
  const rule = items.find((item) => item.id === id);
  if (!rule) throw new ApiError('NOT_FOUND', '规则不存在', 404);
  if (rule.builtin) {
    throw new ApiError('BUILTIN_RULE', '内置红线规则只读，不能删除', 409);
  }
  save(items.filter((item) => item.id !== id));
}

export function resetRulesState(): void {
  writeStore(STORE_KEY, rulesFixture);
}
