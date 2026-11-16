/**
 * 顾问 Agent（#167）的工具定义、参数校验与检索逻辑。
 *
 * 工具是资源原语，不是问题模板：v1 只注册
 * `advisor_overview`（聚合快照）+ `advisor_search` / `advisor_get`（按 scope 分）
 * + `patient_chronic`（患者档案快照）。新增问法不加工具，新增资源类型才加 scope。
 *
 * 检索算法从旧的知识 / 话术关键词查询服务迁入（复用，不复制一套匹配算法）。
 * 原文照抄：知识 / 话术 / 规则的结果必须携带机构原文，render 逐字输出，
 * 模型只做「找到 + 排版」，评测按「返回文本与库内原文逐字相等」判定。
 */
import { buildTodoSnapshot, formatTodoText } from './format.ts';
import type {
  AdvisorChronicResult,
  AdvisorGetResult,
  AdvisorMealsResult,
  AdvisorOverviewResult,
  AdvisorSearchResult,
} from './types.ts';

// ---------- 会话 → 顾问身份 ----------

export const ADVISOR_SESSION_PREFIX = 'zhiban-advisor-';

/** 身份只从会话 id 解析；工具参数里没有 advisorId，伪造无效 */
export function advisorIdFromSession(sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(ADVISOR_SESSION_PREFIX)) {
    return undefined;
  }
  const id = sessionId.slice(ADVISOR_SESSION_PREFIX.length);
  return id === '' ? undefined : id;
}

// ---------- 参数校验 ----------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text.slice(0, max);
}

export const ADVISOR_SEARCH_SCOPES = ['patient', 'knowledge', 'script', 'alert'] as const;
export const ADVISOR_GET_SCOPES = [
  'patient',
  'knowledge',
  'script',
  'alert',
  'rule',
] as const;
export type AdvisorSearchScope = (typeof ADVISOR_SEARCH_SCOPES)[number];
export type AdvisorGetScope = (typeof ADVISOR_GET_SCOPES)[number];

function parseScope(value: unknown, allowed: readonly string[], field: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const scope = value.trim();
  return allowed.includes(scope) ? scope : undefined;
}

export interface AdvisorSearchArgs {
  scope: AdvisorSearchScope;
  query: string;
}

export function validateAdvisorSearch(args: unknown): ValidationResult<AdvisorSearchArgs> {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const violations: string[] = [];
  const scope = parseScope(args.scope, ADVISOR_SEARCH_SCOPES, 'scope');
  if (!scope) {
    violations.push(`scope 必须是 ${ADVISOR_SEARCH_SCOPES.join('/')}`);
  }
  const query = boundedString(args.query, 'query', 100);
  if (query === undefined) violations.push('query 不能为空，最多 100 字');
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { scope: scope as AdvisorSearchScope, query: query as string } };
}

export interface AdvisorGetArgs {
  scope: AdvisorGetScope;
  id: string;
}

export function validateAdvisorGet(args: unknown): ValidationResult<AdvisorGetArgs> {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const violations: string[] = [];
  const scope = parseScope(args.scope, ADVISOR_GET_SCOPES, 'scope');
  if (!scope) {
    violations.push(`scope 必须是 ${ADVISOR_GET_SCOPES.join('/')}`);
  }
  const id = boundedString(args.id, 'id', 80);
  if (id === undefined) violations.push('id 不能为空，最多 80 字');
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { scope: scope as AdvisorGetScope, id: id as string } };
}

export interface AdvisorChronicArgs {
  patientId: string;
}

export function validateAdvisorChronic(args: unknown): ValidationResult<AdvisorChronicArgs> {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const violations: string[] = [];
  const patientId = boundedString(args.patientId, 'patientId', 80);
  if (patientId === undefined) violations.push('patientId 不能为空，最多 80 字');
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { patientId: patientId as string } };
}

export interface AdvisorMealsArgs {
  patientId: string;
  /** YYYY-MM-DD（上海时区）；缺省为今天 */
  date?: string;
}

export function validateAdvisorMeals(args: unknown): ValidationResult<AdvisorMealsArgs> {
  if (!isRecord(args)) return { ok: false, violations: ['参数必须是对象'] };
  const violations: string[] = [];
  const patientId = boundedString(args.patientId, 'patientId', 80);
  if (patientId === undefined) violations.push('patientId 不能为空，最多 80 字');
  const date = boundedString(args.date, 'date', 10);
  if (args.date !== undefined && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    violations.push('date 必须是 YYYY-MM-DD');
  }
  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: { patientId: patientId as string, ...(date ? { date } : {}) },
  };
}

// ---------- 检索（从旧知识 / 话术查询服务迁入） ----------

export interface QueryableKnowledgeLike {
  id: string;
  category: string;
  title: string;
  content: string;
  enabled?: boolean;
  deletedAt?: number;
}

export interface QueryableScriptLike {
  id: string;
  category: string;
  title: string;
  content: string;
  tags?: string[];
}

/** 标题命中优先于分类，最后才是正文 */
export function rankKnowledge(record: QueryableKnowledgeLike, query: string): number {
  const lowered = query.toLowerCase();
  if (record.title.toLowerCase().includes(lowered)) return 3;
  if (record.category.toLowerCase().includes(lowered)) return 2;
  if (record.content.toLowerCase().includes(lowered)) return 1;
  return 0;
}

export function isUsableKnowledge(record: QueryableKnowledgeLike): boolean {
  return record.enabled !== false && record.deletedAt === undefined;
}

export function searchKnowledge(
  records: QueryableKnowledgeLike[],
  query: string,
): QueryableKnowledgeLike[] {
  const lowered = query.toLowerCase();
  return records
    .filter((record) => rankKnowledge(record, lowered) > 0)
    .sort((a, b) => rankKnowledge(b, lowered) - rankKnowledge(a, lowered));
}

function includesQuery(value: string, query: string): boolean {
  return value.toLowerCase().includes(query);
}

/** 标题命中优先于分类/标签，最后才是正文 */
export function rankScript(script: QueryableScriptLike, query: string): number {
  if (includesQuery(script.title, query)) return 3;
  if (includesQuery(script.category, query)) return 2;
  if ((script.tags ?? []).some((tag) => includesQuery(tag, query))) return 2;
  if (includesQuery(script.content, query)) return 1;
  return 0;
}

/**
 * 关键词正好是分类名时只返回该分类，避免「查话术」把正文提到该词的话术也带出来；
 * 否则按标题 > 分类/标签 > 正文排序。
 */
export function searchScripts(
  scripts: QueryableScriptLike[],
  query: string,
): QueryableScriptLike[] {
  const lowered = query.toLowerCase();
  const exactCategory = scripts.filter(
    (script) => script.category.toLowerCase() === lowered,
  );
  if (exactCategory.length > 0) {
    return [...exactCategory].sort((a, b) => a.title.localeCompare(b.title));
  }
  return scripts
    .filter((script) => rankScript(script, lowered) > 0)
    .sort(
      (a, b) =>
        rankScript(b, lowered) - rankScript(a, lowered) ||
        a.title.localeCompare(b.title),
    );
}

/** 患者名掩码：patient.read 未授权时只返回 id 尾号，不能把昵称当事实返回 */
export function maskedDisplayName(displayName: string | undefined, id: string): string {
  const name = displayName?.trim();
  if (name && name !== '') return name;
  return `患者 ${id.slice(-6)}`;
}

// ---------- 工具定义 ----------

export interface AdvisorToolHandlers {
  overview(advisorId: string): Promise<AdvisorOverviewResult>;
  search(
    advisorId: string,
    scope: AdvisorSearchScope,
    query: string,
  ): Promise<AdvisorSearchResult>;
  get(advisorId: string, scope: AdvisorGetScope, id: string): Promise<AdvisorGetResult>;
  chronic(advisorId: string, patientId: string): Promise<AdvisorChronicResult>;
  meals(advisorId: string, patientId: string, date?: string): Promise<AdvisorMealsResult>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  output: {
    schema: unknown;
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  timeoutMs?: number;
  execute(
    args: unknown,
    exec: { agent?: { id: string }; concludeTurn?(): void },
  ): Promise<unknown>;
}

function toolError(violations: string[]): never {
  throw new Error(`INVALID_TOOL_ARGS ${violations.join('; ')}`);
}

const SEARCH_LIMIT = 5;

const STRING = { type: 'string' } as const;

const OVERVIEW_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    snapshot: { type: 'object' },
  },
  required: ['snapshot'],
  additionalProperties: false,
} as const;

const SEARCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    scope: { type: 'string' },
    query: { type: 'string' },
    found: { type: 'integer' },
    items: { type: 'array' },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

const GET_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    scope: { type: 'string' },
    id: { type: 'string' },
    item: { type: 'object' },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

const CHRONIC_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    patientId: { type: 'string' },
    hasRecord: { type: 'boolean' },
    displayName: { type: 'string' },
    conditions: { type: 'array' },
    medications: { type: 'array' },
    recentMeasurements: { type: 'array' },
    updatedAt: { type: 'integer' },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

const MEALS_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    patientId: { type: 'string' },
    displayName: { type: 'string' },
    date: { type: 'string' },
    hasRecord: { type: 'boolean' },
    meals: { type: 'array' },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

/** 检索结果 render：知识 / 话术逐字输出原文并带条目 id，模型只做排版 */
export function renderSearch(value: AdvisorSearchResult): string {
  if (value.status === 'unconnected') return '这一类数据还没接入，请稍后再试或联系管理员。';
  if (value.found === 0) return `没有找到与「${value.query}」相关的条目。`;

  const labels: Record<AdvisorSearchScope, string> = {
    patient: '患者',
    knowledge: '知识库',
    script: '话术库',
    alert: '告警',
  };
  const lines = value.items.map((item, index) => {
    const heading = `${index + 1}. [${item.id}] ${item.title}${item.category ? `（${item.category}）` : ''}`;
    const body =
      item.content !== undefined && item.content !== ''
        ? `\n${item.content}`
        : item.at !== undefined
          ? `\n${new Date(item.at).toISOString()}${item.severity ? ` · ${item.severity}` : ''}`
          : '';
    return `${heading}${body}`;
  });
  const more =
    value.found > value.items.length
      ? `\n只显示前 ${value.items.length} 条，可以再加一个关键词。`
      : '';
  return (
    `在${labels[value.scope]}里找到 ${value.found} 条：\n${lines.join('\n')}${more}\n\n` +
    '引用时带上条目 id；涉及知识 / 话术的内容必须原样引用，不得改写。'
  );
}

/** get render：知识 / 话术 / 规则逐字输出原文 */
export function renderGet(value: AdvisorGetResult): string {
  if (value.status === 'unconnected') return '这一类数据还没接入，请稍后再试或联系管理员。';
  if (value.status === 'forbidden') return '没有权限查看这条内容。';
  if (value.status === 'not-found') return `没有找到 ${value.scope} 里的 ${value.id}。`;
  const item = value.item;
  const tagLine =
    item.tags && item.tags.length > 0 ? ` · 标签：${item.tags.join('、')}` : '';
  return (
    `【${item.title}】${item.category ?? ''}${tagLine}\n\n` +
    `${item.content ?? ''}` +
    `\n\n来源：${value.scope} ${value.id}。涉及知识 / 话术 / 规则的内容必须原样引用，不得改写。`
  );
}

function renderChronic(value: AdvisorChronicResult): string {
  if (value.status === 'unconnected') return '患者档案还没接入，请稍后再试或联系管理员。';
  if (value.status === 'forbidden') return '没有权限查看这位患者的档案。';
  if (!value.hasRecord) {
    return `患者（${value.displayName}）目前没有慢病档案记录，没有可查的体征、用药或疾病信息。`;
  }
  // #167：事实卡优先（含身高体重、最近饮食、长期记忆），格式与患者侧注入同一份
  if (value.facts && value.facts.length > 0) {
    return [
      ...value.facts,
      '以上是系统里已有的信息；没有的字段如实说明没有，不要用通识补成个性化结论。',
    ].join('\n');
  }
  const lines: string[] = [`患者 ${value.displayName} 的慢病档案：`];
  if (value.conditions.length > 0) {
    lines.push(`疾病：${value.conditions.join('、')}`);
  }
  if (value.recentMeasurements.length > 0) {
    lines.push(`最近体征（${value.recentMeasurements.length} 条）：`);
    for (const line of value.recentMeasurements) lines.push(`· ${line}`);
  }
  if (value.medications.length > 0) {
    lines.push(`用药：${value.medications.join('、')}`);
  }
  if (value.updatedAt !== undefined) {
    lines.push(`更新时间：${new Date(value.updatedAt).toISOString()}`);
  }
  lines.push('以上均为档案里已有的记录，未记录的指标如实说明没有。');
  return lines.join('\n');
}

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

function renderMeals(value: AdvisorMealsResult): string {
  if (value.status === 'unconnected') return '饮食记录还没接入，请稍后再试或联系管理员。';
  if (value.status === 'forbidden') return '没有权限查看这位患者的饮食记录。';
  if (value.status === 'not-found') return '没有找到这位患者，无法查询饮食记录。';
  const head = `患者 ${value.displayName} · ${value.date} 的饮食记录：`;
  if (!value.hasRecord) {
    return `${head}\n这一天没有饮食记录。`;
  }
  const lines: string[] = [head];
  for (const meal of value.meals) {
    const label = MEAL_TYPE_LABELS[meal.mealType] ?? meal.mealType;
    lines.push(`· ${label} ${meal.time}：${meal.foods.join('、')}`);
    if (meal.notes) lines.push(`  备注：${meal.notes}`);
    if (meal.agentComment) lines.push(`  记录说明：${meal.agentComment}`);
    lines.push(`  置信度：${Math.round(meal.confidence * 100)}%`);
  }
  lines.push('以上是系统里已有的记录；没有记录的餐次如实说明没有，不要照模板补。');
  return lines.join('\n');
}

/**
 * 生成 DSH 可直接注册的顾问工具。`exec.agent.id` 是顾问会话 id
 * （`zhiban-advisor-<advisorId>`），由此反查顾问身份；工具参数里不接受 advisorId。
 * `resolveAdvisorId` 用于会话 id 与顾问 id 不满足前缀推导时的兜底映射。
 */
export function buildAdvisorToolDefinitions(
  handlers: AdvisorToolHandlers,
  options?: { resolveAdvisorId?: (sessionId: string) => string | undefined },
): RegisteredTool[] {
  const resolveAdvisorId = (sessionId: string | undefined): string | undefined => {
    if (options?.resolveAdvisorId && sessionId) {
      const mapped = options.resolveAdvisorId(sessionId);
      if (mapped) return mapped;
    }
    return advisorIdFromSession(sessionId);
  };
  return [
    {
      name: 'advisor_overview',
      description:
        '顾问本人的待办快照：未完成草稿、今日到期承诺、未处理告警、待回复会话数，以及最久等待与当前活动草稿。无参数。回答「今天有什么要我处理的 / 我有哪些待办」时先调它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: OVERVIEW_RESULT_SCHEMA,
        render: (_args, value) => {
          const result = value as AdvisorOverviewResult;
          const snapshot = result.snapshot;
          return [{ type: 'text', text: formatTodoText(snapshot) }];
        },
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const advisorId = resolveAdvisorId(exec.agent?.id);
        if (!advisorId) toolError(['没有关联的顾问会话']);
        return handlers.overview(advisorId);
      },
    },
    {
      name: 'advisor_search',
      description:
        '在某一类资源里按关键词找本人名下的条目。scope 只能是 patient / knowledge / script / alert；patient 按患者昵称或标签找，knowledge / script 按标题、分类、正文找，alert 按告警标题找。未命中会明确说明，不要猜。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ADVISOR_SEARCH_SCOPES,
            description: 'patient=患者 / knowledge=知识库 / script=话术 / alert=告警',
          },
          query: { type: 'string', description: '关键词，最多 100 字' },
        },
        required: ['scope', 'query'],
        additionalProperties: false,
      },
      output: {
        schema: SEARCH_RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderSearch(value as AdvisorSearchResult) }],
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const advisorId = resolveAdvisorId(exec.agent?.id);
        if (!advisorId) toolError(['没有关联的顾问会话']);
        const parsed = validateAdvisorSearch(args);
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.search(advisorId, parsed.value.scope, parsed.value.query);
      },
    },
    {
      name: 'advisor_get',
      description:
        '按 id 取单条详情。scope 可以是 patient / knowledge / script / alert / rule；rule 只能在这里取，不含搜索。id 来自 advisor_search / advisor_overview 的结果或用户消息里给出的编号。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ADVISOR_GET_SCOPES,
            description: 'patient=患者 / knowledge=知识 / script=话术 / alert=告警 / rule=红线规则',
          },
          id: { type: 'string', description: '条目 id，最多 80 字' },
        },
        required: ['scope', 'id'],
        additionalProperties: false,
      },
      output: {
        schema: GET_RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderGet(value as AdvisorGetResult) }],
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const advisorId = resolveAdvisorId(exec.agent?.id);
        if (!advisorId) toolError(['没有关联的顾问会话']);
        const parsed = validateAdvisorGet(args);
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.get(advisorId, parsed.value.scope, parsed.value.id);
      },
    },
    {
      name: 'patient_chronic',
      description:
        '一位患者的事实卡：疾病、身高体重、用药、最近体征、最近饮食与长期记忆（过敏/忌口、口味偏好等）。patientId 必须来自 advisor_search(scope=patient) 或 advisor_get(scope=patient) 的结果，不能猜。给餐食/运动/作息建议前先调它；没有的字段如实说没有，不得补数值或用通识冒充个性化。',
      parameters: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '患者 id，最多 80 字' },
        },
        required: ['patientId'],
        additionalProperties: false,
      },
      output: {
        schema: CHRONIC_RESULT_SCHEMA,
        render: (_args, value) => [
          { type: 'text', text: renderChronic(value as AdvisorChronicResult) },
        ],
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const advisorId = resolveAdvisorId(exec.agent?.id);
        if (!advisorId) toolError(['没有关联的顾问会话']);
        const parsed = validateAdvisorChronic(args);
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.chronic(advisorId, parsed.value.patientId);
      },
    },
    {
      name: 'patient_meals',
      description:
        '查一位患者某一天的饮食记录（三餐与加餐、食物、时间、置信度）。patientId 必须来自 advisor_search(scope=patient) 的结果，不能猜。date 传 YYYY-MM-DD（上海时区），不传默认今天。没有记录时明确说「这一天没有饮食记录」，不要照模板补。',
      parameters: {
        type: 'object',
        properties: {
          patientId: { type: 'string', description: '患者 id，最多 80 字' },
          date: {
            type: 'string',
            description: '日期 YYYY-MM-DD（上海时区）；不传为今天',
          },
        },
        required: ['patientId'],
        additionalProperties: false,
      },
      output: {
        schema: MEALS_RESULT_SCHEMA,
        render: (_args, value) => [
          { type: 'text', text: renderMeals(value as AdvisorMealsResult) },
        ],
      },
      timeoutMs: 5000,
      execute: async (args, exec) => {
        const advisorId = resolveAdvisorId(exec.agent?.id);
        if (!advisorId) toolError(['没有关联的顾问会话']);
        const parsed = validateAdvisorMeals(args);
        if (!parsed.ok) toolError(parsed.violations);
        return handlers.meals(advisorId, parsed.value.patientId, parsed.value.date);
      },
    },
  ];
}
