/**
 * PH5-03（#232）患者 H5 域路由：轻量建档 + 食养主张。
 *
 * 契约：docs/PATIENT-H5-api.md §4（/profile）、§9.1（/manifesto 公开）。
 * 挂在骨架 http.ts 的 extensions 装配点上，不改骨架路由。
 */
import { H5Error } from '../../../src/p1/patient-h5.ts';
import type { IdempotencyRecord } from '../../../src/p1/patient-h5.ts';
import { ProfileValidationError } from '../../../src/p1/patient-h5-profile.ts';
import type {
  ProfileEntry,
  ProfileFieldKey,
  ProfileService,
  ProfileStep,
} from '../../../src/p1/patient-h5-profile.ts';
import type { H5RouteExtension } from '../http.ts';

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

/** 域表适配器：patient_profile_entries（表已在骨架域中声明） */
export class DomainProfileBackend {
  private readonly table: AnyTable;
  private readonly idempotencyTable?: AnyTable;
  private readonly tenantId: string;

  constructor(table: AnyTable, tenantId: string, idempotencyTable?: AnyTable) {
    this.table = table;
    this.tenantId = tenantId;
    this.idempotencyTable = idempotencyTable;
  }

  private idemKey(patientId: string, key: string): string {
    return `${this.tenantId}\u0000${patientId}\u0000${key}`;
  }

  async loadIdempotency(patientId: string, key: string, now: number): Promise<unknown> {
    if (!this.idempotencyTable) return undefined;
    const hit = [...this.idempotencyTable.entries()].find(
      ([id, value]) => {
        if (id !== this.idemKey(patientId, key)) return false;
        const record = value as { at: number };
        return now - record.at <= 24 * 60 * 60 * 1000;
      },
    );
    return hit ? (hit[1] as { response?: unknown }).response : undefined;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    if (!this.idempotencyTable) return;
    await this.idempotencyTable.put(this.idemKey(record.patientId, record.key), record);
  }

  loadProfileEntries(): ProfileEntry[] {
    return [...this.table.entries()]
      .map(([, value]) => value as ProfileEntry)
      .filter((item) => item.tenantId === this.tenantId);
  }

  async putProfileEntry(entry: ProfileEntry): Promise<void> {
    await this.table.put(entry.id, entry);
  }
}

export interface ManifestoSection {
  kind: 'classic_quote' | 'plain_explanation' | 'brand_copy';
  text: string;
  citation?: string;
}

export interface ManifestoConfig {
  version: number;
  slogans: string[];
  sections: ManifestoSection[];
}

/** 固定服务文案（PRD §7.3：固定文案随版本配置，非逐条审核内容） */
export const DEFAULT_MANIFESTO: ManifestoConfig = {
  version: 1,
  slogans: ['饮食有养', '起居有常', '健康有伴'],
  sections: [
    {
      kind: 'classic_quote',
      text: '五谷为养，五果为助，五畜为益，五菜为充',
      citation: '《黄帝内经·素问·脏气法时论》',
    },
    {
      kind: 'plain_explanation',
      text: '主食养身、果菜相助：一日三餐里，把种类吃全、份量适当，就是日常的食养。',
    },
    {
      kind: 'brand_copy',
      text: '食养融入日常，健康关怀更早一点。',
    },
  ],
};

const STEPS: ReadonlySet<string> = new Set(['basics', 'routine', 'food', 'safety', 'guidance']);
const FIELD_KEYS: ReadonlySet<string> = new Set([
  'goal',
  'meal_times',
  'sleep_time',
  'food_preference',
  'allergy',
  'existing_guidance',
]);

function profileValidationError(error: ProfileValidationError): H5Error {
  return new H5Error(
    'VALIDATION_FAILED',
    '建档资料有误，请检查后重试',
    error.issues.map((issue) => ({ field: issue.field, issue: issue.issue })),
  );
}

export function createProfileRoutes(options: {
  profile: ProfileService;
  manifesto?: ManifestoConfig;
}): H5RouteExtension[] {
  const manifesto = options.manifesto ?? DEFAULT_MANIFESTO;
  const profile = options.profile;

  /** GET /manifesto —— 公开（未登录可读，PRD H01） */
  const manifestoRoute: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/manifesto' || ctx.method !== 'GET') return false;
    ctx.ok(200, manifesto);
    return true;
  };

  /** GET /profile —— 档案视图（来源与确认状态标注） */
  const profileRoute: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/profile' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    ctx.ok(200, {
      items: profile.list(view.session.patientId),
      status: profile.status(view.session.patientId),
    });
    return true;
  };

  /** PUT /profile/answers —— 分步提交（契约 api §4.3） */
  const answersRoute: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/profile/answers' || ctx.method !== 'PUT') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const step = String(body.step ?? '');
    if (!STEPS.has(step)) {
      throw new H5Error('VALIDATION_FAILED', '未知的建档步骤', [
        { field: 'step', issue: 'invalid step' },
      ]);
    }
    const answers = body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new H5Error('VALIDATION_FAILED', 'answers 必须是对象', [
        { field: 'answers', issue: 'invalid' },
      ]);
    }
    for (const key of Object.keys(answers)) {
      if (!FIELD_KEYS.has(key)) {
        throw new H5Error('VALIDATION_FAILED', '未知的档案字段', [
          { field: 'answers', issue: `unknown field: ${key}` },
        ]);
      }
    }
    try {
      const result = await profile.submitAnswers({
        patientId: view.session.patientId,
        step: step as ProfileStep,
        answers: answers as Partial<Record<ProfileFieldKey, Record<string, unknown>>>,
        decidedVia: view.session.id,
        ...(ctx.idempotencyKey ? { idempotencyKey: `${ctx.idempotencyKey}:${step}` } : {}),
      });
      ctx.ok(200, {
        entries: result.entries,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof ProfileValidationError) throw profileValidationError(error);
      throw error;
    }
    return true;
  };

  /** POST /profile/confirm —— 确认既有资料 */
  const confirmRoute: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/profile/confirm' || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    if (!Array.isArray(body.entryIds)) {
      throw new H5Error('VALIDATION_FAILED', 'entryIds 必须是数组', [
        { field: 'entryIds', issue: 'invalid' },
      ]);
    }
    const entryIds = body.entryIds.filter((item): item is string => typeof item === 'string');
    const confirmed = await profile.confirm(view.session.patientId, entryIds, view.session.id);
    ctx.ok(200, { items: confirmed, status: profile.status(view.session.patientId) });
    return true;
  };

  return [manifestoRoute, profileRoute, answersRoute, confirmRoute];
}
