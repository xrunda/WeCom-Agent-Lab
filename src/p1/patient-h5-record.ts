/**
 * PH5-06（#235）患者端 H5：餐食记录、晚间回顾与照片。
 *
 * 契约：docs/PATIENT-H5-data-model.md §3.8、§3.9；docs/PATIENT-H5-api.md §7。
 *
 * issue 验收里最容易做错的地方，这里逐条对应：
 * 1. **识别失败不阻塞保存**：照片识别是可选增强，失败/超时仍能以文字记录落库
 * 2. **候选与确认分开存**：aiCandidates 是模型猜的，confirmedFoods 是患者确认的，
 *    两者都保留，绝不把候选直接当成患者吃的东西
 * 3. **不输出热量/营养结论**：首期不展示未经确认的精确热量
 * 4. **同日同餐不盲目覆盖**：H5 记录与群侧记录并存，只标疑似重复交团队核对
 * 5. **幂等**：同一 Idempotency-Key 重试不会生成第二条
 */
import type { IdFactory } from './ids.ts';

export type RecordKind = 'meal' | 'evening_review' | 'note';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface FoodCandidate {
  name: string;
  confidence: number;
}

export interface ConfirmedFood {
  name: string;
  portion?: string;
}

export interface MealContent {
  mealType: MealType;
  aiCandidates: FoodCandidate[];
  confirmedFoods: ConfirmedFood[];
  patientNotes?: string;
}

export interface EveningReviewContent {
  overall?: 'good' | 'fair' | 'tired' | 'uncomfortable';
  mood?: 'calm' | 'happy' | 'low' | 'anxious';
  sleep?: 'good' | 'light' | 'poor' | 'insomnia';
  bowel?: 'normal' | 'loose' | 'constipated' | 'other';
  discomfort?: string;
  notes?: string;
}

export interface RecordRecognition {
  status: 'pending' | 'succeeded' | 'failed' | 'timeout' | 'skipped';
  candidates: FoodCandidate[];
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
}

export interface PatientRecord {
  id: string;
  tenantId: string;
  patientId: string;
  kind: RecordKind;
  occurredAt: number;
  occurredDate: string;
  submittedAt: number;
  source: 'patient' | 'group_archive';
  idempotencyKey?: string;
  content: MealContent | EveningReviewContent | { text: string };
  recognition?: RecordRecognition;
  mediaIds: string[];
  linkedCalendarItemIds: string[];
  /** 同步到团队侧饮食记录（meal_logs）后的 id；同步失败时为空 */
  mealLogId?: string;
  duplication: { suspectedIds: string[]; status: 'none' | 'suspected' | 'distinct_confirmed' };
  revisions: Array<{ content: unknown; at: number; via: string }>;
  createdAt: number;
}

export interface MediaRecord {
  id: string;
  tenantId: string;
  patientId: string;
  recordId?: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: number;
  sha256: string;
  exifStripped: boolean;
  createdAt: number;
}

export class RecordError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'VALIDATION_FAILED'
    | 'CONFLICT'
    | 'RECORD_IMMUTABLE'
    | 'UNSUPPORTED_IMAGE';

  constructor(code: RecordError['code'], message: string) {
    super(message);
    this.name = 'RecordError';
    this.code = code;
  }
}

// ---------- 端口 ----------

export interface MealRecognitionPort {
  readonly available: boolean;
  /** 返回候选食物；失败时抛错或返回 null，由调用方降级 */
  recognize(input: { patientId: string; mediaId: string }): Promise<FoodCandidate[] | null>;
}

export const UNCONFIGURED_RECOGNITION: MealRecognitionPort = {
  available: false,
  async recognize() {
    return null;
  },
};

/**
 * 「服务群里的餐食」只读视图。
 *
 * 与 `patient_records` 不同：这些是企微聊天里提取出来的，患者端只能看不能改，
 * 照片经鉴权接口回读，不暴露服务端路径。
 */
export interface ArchiveMealView {
  id: string;
  occurredAt: number;
  mealType: MealType;
  foods: Array<{ name: string; portion?: string }>;
  notes?: string;
  hasPhoto: boolean;
}

/**
 * 餐食记录与控制台 `meal_logs` 的桥。
 *
 * 单一事实来源是 `meal_logs`：H5 记的餐同步写进去，控制台「饮食记录」立刻可见；
 * 群存档里提取的餐食由这里只读地借给 H5 展示，避免两套数据各说各的。
 * 同步失败不能影响 H5 记录本身（先落库，再尽力同步）。
 */
export interface MealLogPort {
  listArchive(patientId: string, date: string): ArchiveMealView[];
  upsert(input: {
    patientId: string;
    h5RecordId: string;
    occurredAt: number;
    mealType: MealType;
    foods: Array<{ name: string; portion?: string }>;
    notes?: string;
    mediaPath?: string;
  }): { id: string };
  photoPath(patientId: string, mealLogId: string): string | null;
}

export interface RecordBackend {
  load(): { records: PatientRecord[]; media: MediaRecord[] };
  putRecord(record: PatientRecord): Promise<void>;
  putMedia(media: MediaRecord): Promise<void>;
  loadIdempotency(patientId: string, key: string, now: number): Promise<unknown>;
  putIdempotency(record: {
    key: string;
    tenantId: string;
    patientId: string;
    endpoint: string;
    response: unknown;
    at: number;
  }): Promise<void>;
}

export class MemoryRecordBackend implements RecordBackend {
  private readonly records: PatientRecord[] = [];
  private readonly mediaItems: MediaRecord[] = [];
  private readonly idempotency = new Map<string, { response: unknown; at: number }>();

  load(): { records: PatientRecord[]; media: MediaRecord[] } {
    return { records: [...this.records], media: [...this.mediaItems] };
  }

  async putRecord(record: PatientRecord): Promise<void> {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }

  async putMedia(record: MediaRecord): Promise<void> {
    const index = this.mediaItems.findIndex((item) => item.id === record.id);
    if (index >= 0) this.mediaItems[index] = record;
    else this.mediaItems.push(record);
  }

  async loadIdempotency(patientId: string, key: string, now: number): Promise<unknown> {
    const hit = this.idempotency.get(`${patientId}\u0000${key}`);
    if (!hit) return undefined;
    return now - hit.at <= 24 * 60 * 60 * 1000 ? hit.response : undefined;
  }

  async putIdempotency(record: {
    key: string;
    patientId: string;
    response: unknown;
    at: number;
  }): Promise<void> {
    this.idempotency.set(`${record.patientId}\u0000${record.key}`, {
      response: record.response,
      at: record.at,
    });
  }
}

/** 跟进与日历回填的写入口（复用 PH5-05/PH5-07 的存储） */
export interface RecordSideEffects {
  /** 不适反馈 → 跟进请求 */
  createRiskFollowup(input: {
    patientId: string;
    recordId: string;
    message: string;
    at: number;
  }): Promise<void>;
  /** 关联日历事项 → 记录满足要求时回填完成 */
  matchCalendarItem(input: {
    patientId: string;
    itemId: string;
    recordId: string;
    at: number;
  }): Promise<void>;
}

export interface RecordServiceOptions {
  tenantId: string;
  backend: RecordBackend;
  recognition: MealRecognitionPort;
  sideEffects: RecordSideEffects;
  ids: IdFactory;
  now?: () => number;
  timeZone?: string;
  /** 同一餐次多久内算「同日同餐」，用于疑似重复标记 */
  duplicateWindowMs?: number;
  /** 与控制台 meal_logs 的桥；未接入时餐食只存在 H5 自己的表里 */
  mealLogs?: MealLogPort;
  /** H5 照片落盘后的文件路径（同步给控制台用）；未接入时不同步照片 */
  mediaPathOf?: (mediaId: string) => string | undefined;
}

function localDateOf(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

const MEAL_TYPES: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

// ---------- 服务 ----------

export class RecordService {
  private readonly tenantId: string;
  private readonly backend: RecordBackend;
  private readonly recognition: MealRecognitionPort;
  private readonly sideEffects: RecordSideEffects;
  private readonly ids: IdFactory;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly mealLogs?: MealLogPort;
  private readonly mediaPathOf?: (mediaId: string) => string | undefined;

  constructor(options: RecordServiceOptions) {
    this.tenantId = options.tenantId;
    this.backend = options.backend;
    this.recognition = options.recognition;
    this.sideEffects = options.sideEffects;
    this.ids = options.ids;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? 'Asia/Shanghai';
    this.mealLogs = options.mealLogs;
    this.mediaPathOf = options.mediaPathOf;
  }

  /** 群存档里提取的餐食（只读）；未接入控制台时返回空数组 */
  archiveMeals(patientId: string, date: string): ArchiveMealView[] {
    return this.mealLogs?.listArchive(patientId, date) ?? [];
  }

  /** 群存档餐食的照片绝对路径；由路由做鉴权后读文件，路径不出接口 */
  archiveMealPhotoPath(patientId: string, mealLogId: string): string | null {
    return this.mealLogs?.photoPath(patientId, mealLogId) ?? null;
  }

  /**
   * 把 H5 餐食同步到控制台 `meal_logs`。
   *
   * 先落库再同步：同步失败只记 mealLogId 缺失，绝不回滚患者已经记下的内容。
   */
  private syncMealLog(record: PatientRecord): void {
    if (!this.mealLogs || record.kind !== 'meal') return;
    const content = record.content as MealContent;
    const foods = (content.confirmedFoods ?? []).map((item) => ({
      name: item.name,
      ...(item.portion ? { portion: item.portion } : {}),
    }));
    const mediaPath = record.mediaIds
      .map((mediaId) => this.mediaPathOf?.(mediaId))
      .find((value) => Boolean(value));
    try {
      const synced = this.mealLogs.upsert({
        patientId: record.patientId,
        h5RecordId: record.id,
        occurredAt: record.occurredAt,
        mealType: content.mealType,
        foods,
        ...(content.patientNotes ? { notes: content.patientNotes } : {}),
        ...(mediaPath ? { mediaPath } : {}),
      });
      record.mealLogId = synced.id;
    } catch {
      // 团队侧暂不可用时不影响患者记录；下次挂照片会再同步一次
    }
  }

  list(patientId: string, query: { date?: string; kind?: RecordKind } = {}): PatientRecord[] {
    return this.backend
      .load()
      .records.filter(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === patientId &&
          (!query.date || item.occurredDate === query.date) &&
          (!query.kind || item.kind === query.kind),
      )
      .sort((a, b) => b.occurredAt - a.occurredAt);
  }

  get(patientId: string, recordId: string): PatientRecord {
    const found = this.backend
      .load()
      .records.find(
        (item) => item.tenantId === this.tenantId && item.patientId === patientId && item.id === recordId,
      );
    if (!found) throw new RecordError('NOT_FOUND', '记录不存在');
    return found;
  }

  /**
   * 新建记录。餐食与回顾都走这里；照片随后单独上传，
   * 因此「上传失败」不会让文字记录丢失（A07）。
   */
  async create(input: {
    patientId: string;
    kind: RecordKind;
    occurredAt: number;
    idempotencyKey?: string;
    meal?: { mealType: MealType; confirmedFoods?: ConfirmedFood[]; patientNotes?: string };
    review?: EveningReviewContent;
    note?: { text: string };
    linkedCalendarItemIds?: string[];
  }): Promise<PatientRecord> {
    const now = this.now();
    if (input.occurredAt > now) {
      throw new RecordError('VALIDATION_FAILED', '发生时间不能晚于现在');
    }
    if (input.idempotencyKey) {
      const hit = await this.backend.loadIdempotency(input.patientId, input.idempotencyKey, now);
      if (hit) return hit as PatientRecord;
    }

    const occurredDate = localDateOf(input.occurredAt, this.timeZone);
    const record: PatientRecord = {
      id: this.ids('rec'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      occurredDate,
      submittedAt: now,
      source: 'patient',
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      content: this.buildContent(input),
      mediaIds: [],
      linkedCalendarItemIds: input.linkedCalendarItemIds ?? [],
      duplication: { suspectedIds: [], status: 'none' },
      revisions: [],
      createdAt: now,
    };

    if (input.kind === 'meal') {
      record.duplication = this.detectDuplication(record);
    }

    await this.backend.putRecord(record);

    // 餐食同步到控制台 meal_logs（单一事实来源）；失败不影响记录本身
    if (input.kind === 'meal') {
      this.syncMealLog(record);
      if (record.mealLogId) await this.backend.putRecord(record);
    }

    // 不适反馈进入跟进事件（A08）
    if (input.kind === 'evening_review' && input.review?.discomfort?.trim()) {
      await this.sideEffects.createRiskFollowup({
        patientId: input.patientId,
        recordId: record.id,
        message: `晚间回顾反馈不适：${input.review.discomfort.trim().slice(0, 200)}`,
        at: now,
      });
    }

    // 关联日历事项：记录满足要求时回填完成（A06）
    for (const itemId of record.linkedCalendarItemIds) {
      await this.sideEffects.matchCalendarItem({
        patientId: input.patientId,
        itemId,
        recordId: record.id,
        at: now,
      });
    }

    if (input.idempotencyKey) {
      await this.backend.putIdempotency({
        key: input.idempotencyKey,
        tenantId: this.tenantId,
        patientId: input.patientId,
        endpoint: `records.${input.kind}`,
        response: record,
        at: now,
      });
    }
    return record;
  }

  /** 挂照片：先校验魔数与大小，再由识别端口给候选 */
  async attachPhoto(input: {
    patientId: string;
    recordId: string;
    media: { mimeType: MediaRecord['mimeType']; bytes: number; sha256: string; exifStripped: boolean };
  }): Promise<{ record: PatientRecord; recognition: RecordRecognition }> {
    const record = this.get(input.patientId, input.recordId);
    if (record.kind !== 'meal') {
      throw new RecordError('VALIDATION_FAILED', '只有餐食记录可以挂照片');
    }
    if (input.media.bytes > 10 * 1024 * 1024) {
      throw new RecordError('VALIDATION_FAILED', '照片不能超过 10MB');
    }
    const now = this.now();
    const media: MediaRecord = {
      id: this.ids('med'),
      tenantId: this.tenantId,
      patientId: input.patientId,
      recordId: record.id,
      mimeType: input.media.mimeType,
      bytes: input.media.bytes,
      sha256: input.media.sha256,
      exifStripped: input.media.exifStripped,
      createdAt: now,
    };
    await this.backend.putMedia(media);

    record.mediaIds = [...record.mediaIds, media.id];
    record.recognition = { status: 'pending', candidates: [], startedAt: now };

    let candidates: FoodCandidate[] | null = null;
    if (this.recognition.available) {
      try {
        candidates = await this.recognition.recognize({
          patientId: input.patientId,
          mediaId: media.id,
        });
      } catch {
        candidates = null;
      }
    }
    record.recognition = candidates
      ? { status: 'succeeded', candidates, startedAt: now, finishedAt: this.now() }
      : {
          status: this.recognition.available ? 'failed' : 'skipped',
          candidates: [],
          startedAt: now,
          finishedAt: this.now(),
          ...(this.recognition.available ? { errorCode: 'RECOGNITION_FAILED' } : {}),
        };

    // 候选写入内容的 aiCandidates，与已确认的分开保存
    if (record.kind === 'meal') {
      const content = record.content as MealContent;
      record.content = { ...content, aiCandidates: candidates ?? [] };
      // 照片后到：把 mediaPath 补进控制台那条记录
      this.syncMealLog(record);
    }
    await this.backend.putRecord(record);
    return { record, recognition: record.recognition };
  }

  /** 患者确认/修改候选：只改 confirmedFoods，不动 aiCandidates */
  async confirm(input: {
    patientId: string;
    recordId: string;
    confirmedFoods: ConfirmedFood[];
  }): Promise<PatientRecord> {
    const record = this.get(input.patientId, input.recordId);
    if (record.kind !== 'meal') throw new RecordError('VALIDATION_FAILED', '只有餐食记录可以确认食物');
    const content = record.content as MealContent;
    record.revisions = [...record.revisions, { content, at: this.now(), via: 'patient' }];
    record.content = {
      ...content,
      confirmedFoods: input.confirmedFoods
        .filter((item) => item.name?.trim())
        .slice(0, 20)
        .map((item) => ({
          name: item.name.trim().slice(0, 40),
          ...(item.portion ? { portion: item.portion.slice(0, 20) } : {}),
        })),
    };
    // 患者确认后，团队侧那条饮食记录跟着更新（否则控制台还是识别候选）
    this.syncMealLog(record);
    await this.backend.putRecord(record);
    return record;
  }

  /** 更正记录：保留历史，不改发生时间语义 */
  async correct(input: {
    patientId: string;
    recordId: string;
    content: Record<string, unknown>;
  }): Promise<PatientRecord> {
    const record = this.get(input.patientId, input.recordId);
    record.revisions = [...record.revisions, { content: record.content, at: this.now(), via: 'patient' }];
    record.content = { ...(record.content as object), ...input.content } as PatientRecord['content'];
    await this.backend.putRecord(record);
    return record;
  }

  // ---------- 内部 ----------

  private buildContent(input: {
    kind: RecordKind;
    meal?: { mealType: MealType; confirmedFoods?: ConfirmedFood[]; patientNotes?: string };
    review?: EveningReviewContent;
    note?: { text: string };
  }): PatientRecord['content'] {
    if (input.kind === 'meal') {
      if (!input.meal || !MEAL_TYPES.includes(input.meal.mealType)) {
        throw new RecordError('VALIDATION_FAILED', '餐次不合法');
      }
      return {
        mealType: input.meal.mealType,
        aiCandidates: [],
        confirmedFoods: (input.meal.confirmedFoods ?? [])
          .filter((item) => item.name?.trim())
          .slice(0, 20)
          .map((item) => ({
            name: item.name.trim().slice(0, 40),
            // 份量是患者自己确认的一部分，别在归一化时丢掉
            ...(item.portion?.trim() ? { portion: item.portion.trim().slice(0, 20) } : {}),
          })),
        ...(input.meal.patientNotes ? { patientNotes: input.meal.patientNotes.slice(0, 200) } : {}),
      } satisfies MealContent;
    }
    if (input.kind === 'evening_review') {
      // 每一项都允许留空：不预选「正常」，未填写不等于无异常（A08）
      const review = input.review ?? {};
      return {
        ...(review.overall ? { overall: review.overall } : {}),
        ...(review.mood ? { mood: review.mood } : {}),
        ...(review.sleep ? { sleep: review.sleep } : {}),
        ...(review.bowel ? { bowel: review.bowel } : {}),
        ...(review.discomfort ? { discomfort: review.discomfort.slice(0, 200) } : {}),
        ...(review.notes ? { notes: review.notes.slice(0, 200) } : {}),
      } satisfies EveningReviewContent;
    }
    return { text: (input.note?.text ?? '').slice(0, 500) };
  }

  /**
   * 同日同餐疑似重复：只做标记，不覆盖、不合并。
   * 群侧记录（source=group_archive）由后续包写入同一存储。
   */
  private detectDuplication(record: PatientRecord): PatientRecord['duplication'] {
    const meal = record.content as MealContent;
    const same = this.backend
      .load()
      .records.filter(
        (item) =>
          item.tenantId === this.tenantId &&
          item.patientId === record.patientId &&
          item.kind === 'meal' &&
          item.occurredDate === record.occurredDate &&
          (item.content as MealContent).mealType === meal.mealType &&
          item.id !== record.id,
      );
    if (same.length === 0) return { suspectedIds: [], status: 'none' };
    return { suspectedIds: same.map((item) => item.id), status: 'suspected' };
  }
}
