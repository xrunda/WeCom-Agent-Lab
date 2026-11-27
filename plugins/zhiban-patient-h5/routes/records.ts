/**
 * PH5-06（#235）患者记录路由（契约 api §7）。
 *
 * 关键顺序：先建文字记录，再传照片。照片上传/识别失败只影响 recognition 状态，
 * 已保存的记录不会因此丢失（A07）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { H5Error } from '../../../src/p1/patient-h5.ts';
import { prepareImage } from '../../../src/p1/patient-h5-media.ts';
import { RecordError } from '../../../src/p1/patient-h5-record.ts';
import type { RecordKind, RecordService } from '../../../src/p1/patient-h5-record.ts';
import type { H5RouteExtension } from '../http.ts';

export interface MediaStore {
  put(id: string, data: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | undefined>;
}

interface AnyTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

/** 域表适配器：patient_records + h5_media + idempotency_records */
export class DomainRecordBackend {
  private readonly records: AnyTable;
  private readonly media: AnyTable;
  private readonly idempotency: AnyTable | undefined;
  private readonly tenantId: string;

  constructor(records: AnyTable, media: AnyTable, idempotency: AnyTable | undefined, tenantId: string) {
    this.records = records;
    this.media = media;
    this.idempotency = idempotency;
    this.tenantId = tenantId;
  }

  load(): { records: never[]; media: never[] } {
    const values = <T>(table: AnyTable): T[] =>
      [...table.entries()].map(([, value]) => value as T).filter(
        (item) => (item as { tenantId?: string }).tenantId === this.tenantId,
      );
    return {
      records: values(this.records) as never[],
      media: values(this.media) as never[],
    };
  }

  async putRecord(record: { id: string }): Promise<void> {
    await this.records.put(record.id, record);
  }

  async putMedia(record: { id: string }): Promise<void> {
    await this.media.put(record.id, record);
  }

  async loadIdempotency(patientId: string, key: string, now: number): Promise<unknown> {
    if (!this.idempotency) return undefined;
    const id = `${this.tenantId}\u0000${patientId}\u0000${key}`;
    const hit = [...this.idempotency.entries()].find(([entryId]) => entryId === id);
    if (!hit) return undefined;
    const record = hit[1] as { at: number; response?: unknown };
    return now - record.at <= 24 * 60 * 60 * 1000 ? record.response : undefined;
  }

  async putIdempotency(record: {
    key: string;
    patientId: string;
    at: number;
    response: unknown;
  }): Promise<void> {
    if (!this.idempotency) return;
    await this.idempotency.put(
      `${this.tenantId}\u0000${record.patientId}\u0000${record.key}`,
      record,
    );
  }
}

/**
 * 照片落盘存储。
 *
 * 原来用内存 Map，进程一重启照片就丢；而控制台「饮食记录」是通过
 * `meal_logs.mediaPath` 直接读文件的——内存存储会让 H5 记的餐在控制台永远没有图。
 */
export class FileMediaStore implements MediaStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** 落盘路径；同步给 `meal_logs.mediaPath`，控制台据此回读 */
  pathOf(id: string): string {
    return join(this.root, id);
  }

  async put(id: string, data: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.pathOf(id), data);
  }

  async get(id: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.pathOf(id));
    } catch {
      return undefined;
    }
  }
}

export class MemoryMediaStore implements MediaStore {
  private readonly items = new Map<string, Buffer>();

  async put(id: string, data: Buffer): Promise<void> {
    this.items.set(id, data);
  }

  async get(id: string): Promise<Buffer | undefined> {
    return this.items.get(id);
  }
}

const MAX_UPLOAD = 12 * 1024 * 1024;

function toH5Error(error: unknown): never {
  if (error instanceof RecordError) {
    const map = {
      NOT_FOUND: 'NOT_FOUND',
      VALIDATION_FAILED: 'VALIDATION_FAILED',
      CONFLICT: 'CONFLICT',
      RECORD_IMMUTABLE: 'CONFLICT',
      UNSUPPORTED_IMAGE: 'VALIDATION_FAILED',
    } as const;
    throw new H5Error(map[error.code], error.message);
  }
  throw error;
}

/** 从 multipart 里取第一段文件内容；不是 multipart 时按原始图片处理 */
export function extractImageBody(buffer: Buffer, contentType: string): Buffer | null {
  if (!contentType.startsWith('multipart/form-data')) return buffer;
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const start = buffer.indexOf(delimiter);
  if (start < 0) return null;
  const headerEnd = buffer.indexOf('\r\n\r\n', start);
  if (headerEnd < 0) return null;
  const next = buffer.indexOf(delimiter, headerEnd);
  if (next < 0) return null;
  // 去掉结尾的 CRLF
  return buffer.subarray(headerEnd + 4, Math.max(headerEnd + 4, next - 2));
}

export function createRecordRoutes(options: {
  records: RecordService;
  media: MediaStore;
}): H5RouteExtension[] {
  /** POST /records */
  const create: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/records' || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    const kind = body.kind;
    if (kind !== 'meal' && kind !== 'evening_review' && kind !== 'note') {
      throw new H5Error('VALIDATION_FAILED', 'kind 非法', [{ field: 'kind', issue: 'invalid' }]);
    }
    try {
      const record = await options.records.create({
        patientId: view.session.patientId,
        kind: kind as RecordKind,
        occurredAt: typeof body.occurredAt === 'number' ? body.occurredAt : Date.now(),
        ...(typeof body.idempotencyKey === 'string'
          ? { idempotencyKey: body.idempotencyKey }
          : {}),
        ...(body.meal && typeof body.meal === 'object'
          ? { meal: body.meal as never }
          : {}),
        ...(body.review && typeof body.review === 'object'
          ? { review: body.review as never }
          : {}),
        ...(body.note && typeof body.note === 'object' ? { note: body.note as never } : {}),
        ...(Array.isArray(body.linkedCalendarItemIds)
          ? {
              linkedCalendarItemIds: body.linkedCalendarItemIds.filter(
                (item: unknown): item is string => typeof item === 'string',
              ),
            }
          : {}),
      });
      ctx.ok(201, record);
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** POST /records/:id/photo */
  const photo: H5RouteExtension = async (req, _res, ctx) => {
    const match = /^\/records\/([^/]+)\/photo$/.exec(ctx.path);
    if (!match || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const raw = await ctx.readRawBody(MAX_UPLOAD);
    const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
    const imageBody = extractImageBody(raw, contentType);
    if (!imageBody || imageBody.length === 0) {
      throw new H5Error('VALIDATION_FAILED', '没有收到图片数据', [
        { field: 'photo', issue: 'empty' },
      ]);
    }
    const prepared = prepareImage(imageBody);
    if (!prepared.ok) {
      throw new H5Error(
        'VALIDATION_FAILED',
        prepared.reason === 'TOO_LARGE' ? '照片不能超过 10MB' : '只支持 JPEG / PNG / WebP',
        [{ field: 'photo', issue: prepared.reason }],
      );
    }
    try {
      const result = await options.records.attachPhoto({
        patientId: view.session.patientId,
        recordId: match[1]!,
        media: {
          mimeType: prepared.image.mimeType,
          bytes: prepared.image.bytes,
          sha256: prepared.image.sha256,
          exifStripped: prepared.image.exifStripped,
        },
      });
      const mediaId = result.record.mediaIds[result.record.mediaIds.length - 1]!;
      await options.media.put(mediaId, prepared.image.data);
      ctx.ok(201, {
        mediaId,
        recognition: result.recognition,
        recordId: result.record.id,
      });
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** POST /records/:id/confirm */
  const confirm: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/records\/([^/]+)\/confirm$/.exec(ctx.path);
    if (!match || ctx.method !== 'POST') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    if (!Array.isArray(body.confirmedFoods)) {
      throw new H5Error('VALIDATION_FAILED', 'confirmedFoods 必须是数组', [
        { field: 'confirmedFoods', issue: 'invalid' },
      ]);
    }
    try {
      const record = await options.records.confirm({
        patientId: view.session.patientId,
        recordId: match[1]!,
        confirmedFoods: body.confirmedFoods.filter(
          (item: unknown): item is { name: string } =>
            Boolean(item) && typeof (item as { name?: unknown }).name === 'string',
        ),
      });
      ctx.ok(200, record);
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** GET /records/:id */
  const detail: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/records\/([^/]+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    try {
      ctx.ok(200, options.records.get(view.session.patientId, match[1]!));
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** GET /records?date=&kind= */
  const list: H5RouteExtension = async (_req, _res, ctx) => {
    if (ctx.path !== '/records' || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const date = ctx.query.get('date') ?? undefined;
    const kindRaw = ctx.query.get('kind');
    const kind =
      kindRaw === 'meal' || kindRaw === 'evening_review' || kindRaw === 'note'
        ? (kindRaw as RecordKind)
        : undefined;
    const items = options.records.list(view.session.patientId, {
      ...(date ? { date } : {}),
      ...(kind ? { kind } : {}),
    });
    ctx.ok(200, { items });
    return true;
  };

  /** PATCH /records/:id */
  const correct: H5RouteExtension = async (_req, _res, ctx) => {
    const match = /^\/records\/([^/]+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'PATCH') return false;
    ctx.checkOrigin();
    const view = await ctx.requireSession();
    const body = await ctx.readJson();
    try {
      const record = await options.records.correct({
        patientId: view.session.patientId,
        recordId: match[1]!,
        content: body,
      });
      ctx.ok(200, record);
    } catch (error) {
      toH5Error(error);
    }
    return true;
  };

  /** GET /records/history/archive/:id/photo —— 群存档餐食照片，本人鉴权读取 */
  const archiveMealPhoto: H5RouteExtension = async (_req, res, ctx) => {
    const match = /^\/records\/history\/archive\/([^/]+)\/photo$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const filePath = options.records.archiveMealPhotoPath(view.session.patientId, match[1]!);
    if (!filePath) throw new H5Error('NOT_FOUND', '照片不存在');
    let data: Buffer;
    try {
      data = await readFile(filePath);
    } catch {
      throw new H5Error('NOT_FOUND', '照片不存在');
    }
    const mime = prepareImage(data);
    res.writeHead(200, {
      'Content-Type': mime.ok ? mime.image.mimeType : 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
      'Content-Length': data.length,
      'X-Request-Id': ctx.requestId,
    });
    res.end(data as unknown as string);
    return true;
  };

  /** GET /media/:id —— 本人鉴权读取 */
  const media: H5RouteExtension = async (_req, res, ctx) => {
    const match = /^\/media\/([^/]+)$/.exec(ctx.path);
    if (!match || ctx.method !== 'GET') return false;
    const view = await ctx.requireSession();
    const record = options.records
      .list(view.session.patientId)
      .find((item) => item.mediaIds.includes(match[1]!));
    if (!record) throw new H5Error('NOT_FOUND', '照片不存在');
    const data = await options.media.get(match[1]!);
    if (!data) throw new H5Error('NOT_FOUND', '照片不存在');
    const mime = prepareImage(data);
    res.writeHead(200, {
      'Content-Type': mime.ok ? mime.image.mimeType : 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
      'Content-Length': data.length,
      'X-Request-Id': ctx.requestId,
    });
    res.end(data as unknown as string);
    return true;
  };

  return [photo, confirm, detail, correct, list, media, archiveMealPhoto, create];
}
