/**
 * 会话存档图片拉取（#54）。
 *
 * 官方 `GetMediaData` 按 indexbuf 分片返回，单次 ≤ 512K。这里把
 * 「分片循环 + 失败重试 + 大小校验 + md5 校验 + 落盘」放在 TypeScript 里，
 * 便于离线测试；真正调用企微 SDK 的只有一个每片取数的 C++ 子命令。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface MediaChunk {
  data: Buffer;
  isFinish: boolean;
  nextIndexbuf?: string;
}

export interface MediaChunkSource {
  fetchChunk(sdkfileid: string, indexbuf: string): Promise<MediaChunk>;
}

export interface DownloadMediaOptions {
  /** 单张上限，默认 10 MB */
  maxBytes?: number;
  /** 单个分片失败重试次数，默认 3 */
  retries?: number;
  /** 重试退避，默认 200ms；测试可注入 0 */
  retryDelayMs?: number;
  /** 分片数上限，防御异常 indexbuf 循环 */
  maxChunks?: number;
}

export class MediaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETRIES = 3;
const DEFAULT_MAX_CHUNKS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  action: () => Promise<T>,
  retries: number,
  retryDelayMs: number,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      last = error;
      if (attempt < retries && retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw last instanceof Error ? last : new MediaError('MEDIA_FETCH_FAILED', String(last));
}

/**
 * 循环拉取一张图片的全部分片。
 * 任一错误都抛 `MediaError`；调用方决定标记 `media_failed` 还是重试整张。
 */
export async function downloadMedia(
  source: MediaChunkSource,
  sdkfileid: string,
  options: DownloadMediaOptions = {},
): Promise<Buffer> {
  if (sdkfileid.trim() === '') {
    throw new MediaError('MEDIA_MISSING_FILEID', '存档消息缺少 sdkfileid');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? 200;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  const chunks: Buffer[] = [];
  let total = 0;
  let indexbuf = '';

  for (let chunkNo = 0; chunkNo < maxChunks; chunkNo += 1) {
    const chunk = await withRetry(
      () => source.fetchChunk(sdkfileid, indexbuf),
      retries,
      retryDelayMs,
    );

    if (!Buffer.isBuffer(chunk.data)) {
      throw new MediaError('MEDIA_BAD_CHUNK', 'GetMediaData 返回的不是二进制数据');
    }
    if (chunk.data.length === 0 && !chunk.isFinish) {
      throw new MediaError('MEDIA_NO_PROGRESS', `分片 ${chunkNo} 为空且未结束`);
    }

    chunks.push(chunk.data);
    total += chunk.data.length;
    if (total > maxBytes) {
      throw new MediaError('MEDIA_TOO_LARGE', `图片超过 ${Math.round(maxBytes / 1024)} KB 上限`);
    }

    if (chunk.isFinish) return Buffer.concat(chunks, total);

    const next = chunk.nextIndexbuf ?? '';
    if (next === '' || next === indexbuf) {
      throw new MediaError('MEDIA_NO_PROGRESS', `分片 ${chunkNo} 未返回新的 indexbuf`);
    }
    indexbuf = next;
  }

  throw new MediaError('MEDIA_TOO_MANY_CHUNKS', `图片分片数超过 ${maxChunks}`);
}

export function md5Of(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

/** 根据文件头判断图片扩展名；识别不了就落 .bin，不猜 */
export function detectImageExt(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return 'bin';
}

export interface SaveMediaInput {
  sdkfileid: string;
  roomId: string;
  msgId: string;
  /** 存档消息里的 md5；缺省只记录实际 md5 */
  expectedMd5?: string;
  /** 存档消息里的 filesize；缺省只记录实际大小 */
  expectedSize?: number;
}

export interface SavedMedia {
  path: string;
  md5: string;
  size: number;
  ext: string;
}

export interface MediaDownloaderConfig extends DownloadMediaOptions {
  /** 图片落盘根目录；实际路径为 <root>/<roomId>/<msgId>.<ext> */
  rootDir: string;
}

/** 下载并落盘一张图片 */
export class MediaDownloader {
  private readonly source: MediaChunkSource;
  private readonly config: MediaDownloaderConfig;

  constructor(source: MediaChunkSource, config: MediaDownloaderConfig) {
    this.source = source;
    this.config = config;
  }

  async save(input: SaveMediaInput): Promise<SavedMedia> {
    const buffer = await downloadMedia(this.source, input.sdkfileid, this.config);
    const md5 = md5Of(buffer);
    const size = buffer.length;

    if (input.expectedSize !== undefined && input.expectedSize > 0 && input.expectedSize !== size) {
      throw new MediaError(
        'MEDIA_SIZE_MISMATCH',
        `图片大小不一致：存档 ${input.expectedSize}，实际 ${size}`,
      );
    }
    if (input.expectedMd5 && input.expectedMd5.toLowerCase() !== md5) {
      throw new MediaError('MEDIA_MD5_MISMATCH', '图片 md5 与存档不一致');
    }

    const ext = detectImageExt(buffer);
    const path = join(this.config.rootDir, sanitizeSegment(input.roomId), `${sanitizeSegment(input.msgId)}.${ext}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    return { path, md5, size, ext };
  }
}

/** 群 id / 消息 id 只允许安全字符，避免路径穿越 */
export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned === '' ? '_' : cleaned;
}

export interface ArchiveDumpMediaConfig {
  binaryPath: string;
  configPath: string;
  timeoutMs?: number;
  /** 测试注入：返回子命令 stdout */
  run?: (args: string[]) => Promise<string>;
}

/**
 * 每片调用一次 `archive_dump media`，由 C++ 侧调 GetMediaData。
 * 输出：{"data":"<base64>","isFinish":true,"nextIndexbuf":"..."}
 */
export class ArchiveDumpMediaSource implements MediaChunkSource {
  private readonly config: ArchiveDumpMediaConfig;
  private readonly run?: (args: string[]) => Promise<string>;

  constructor(config: ArchiveDumpMediaConfig) {
    this.config = config;
    this.run = config.run;
  }

  fetchChunk(sdkfileid: string, indexbuf: string): Promise<MediaChunk> {
    const args = ['media', '--json', indexbuf, sdkfileid, this.config.configPath];
    const timeout = this.config.timeoutMs ?? 30_000;
    const run =
      this.run ??
      ((command: string[]) =>
        new Promise<string>((resolve, reject) => {
          execFile(
            this.config.binaryPath,
            command,
            { timeout, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error) {
                reject(new MediaError('MEDIA_EXEC_FAILED', (stderr || error.message).trim()));
                return;
              }
              resolve(stdout);
            },
          );
        }));

    return run(args).then(
      (stdout) =>
        new Promise<MediaChunk>((resolve, reject) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(stdout.trim());
          } catch {
            reject(new MediaError('MEDIA_BAD_OUTPUT', 'archive_dump media 输出不是 JSON'));
            return;
          }
          const out = parsed as {
            data?: unknown;
            isFinish?: unknown;
            nextIndexbuf?: unknown;
          };
          if (typeof out.data !== 'string') {
            reject(new MediaError('MEDIA_BAD_OUTPUT', 'archive_dump media 缺少 data'));
            return;
          }
          resolve({
            data: Buffer.from(out.data, 'base64'),
            isFinish: out.isFinish === true,
            nextIndexbuf:
              typeof out.nextIndexbuf === 'string' && out.nextIndexbuf !== ''
                ? out.nextIndexbuf
                : undefined,
          });
        }),
      (error: unknown) =>
        Promise.reject(
          error instanceof Error ? error : new MediaError('MEDIA_EXEC_FAILED', String(error)),
        ),
    );
  }
}
