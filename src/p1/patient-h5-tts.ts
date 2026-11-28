/**
 * 火山引擎（豆包）语音合成：患者端「听一听」的服务端合成与本地缓存。
 *
 * 设计约定：
 * - 密钥只从环境变量读取，不进仓库、不进日志、不出接口；
 * - 默认音色 `zh_female_tuanzi_uranus_bigtts`（团子，豆包语音合成 2.0）；
 *   3.0 音色（`*_v3_uranus_bigtts`）需要账号在 `volc.service_type.10048`
 *   资源下有可用并发，可用 `VOLC_TTS_VOICE_TYPE` / `VOLC_TTS_RESOURCE_ID` 切换；
 * - 只合成服务端给定的文本（内容库文章标题 + 摘要），不做任意文本代理；
 * - 合成结果按「音色 + 文本」哈希缓存到磁盘，同一篇内容只付一次费；
 * - 失败只抛 `TtsError`（带安全错误码），调用方统一回 503，不把供应商响应透给客户端。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VOLC_TTS_DEFAULT_VOICE = 'zh_female_tuanzi_uranus_bigtts';
export const VOLC_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
/** 单次合成文本上限：文章标题 + 摘要足够，防止被当成通用 TTS 代理 */
export const VOLC_TTS_MAX_TEXT = 800;

export class TtsError extends Error {
  readonly code: 'TTS_NOT_CONFIGURED' | 'TTS_REQUEST_FAILED' | 'TTS_EMPTY_AUDIO';

  constructor(code: TtsError['code'], message: string) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
  }
}

export interface VolcTtsOptions {
  /** 新版控制台的 API Key（推荐）；与 appId + accessToken 二选一 */
  apiKey?: string;
  appId?: string;
  accessToken?: string;
  voiceType?: string;
  /** 缺省按音色推断；`_uranus_` 走 seed-tts-2.0 */
  resourceId?: string;
  sampleRate?: number;
  speedRatio?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 音色 → 资源 ID：与火山控制台的资源包对应 */
export function inferResourceId(voiceType: string): string {
  if (voiceType.startsWith('S_')) return 'seed-icl-2.0';
  if (voiceType.includes('_uranus_') || voiceType.startsWith('saturn_')) return 'seed-tts-2.0';
  return 'seed-tts-1.0';
}

interface JsonChunk {
  code?: unknown;
  message?: unknown;
  data?: unknown;
  header?: { code?: unknown; status_code?: unknown; message?: unknown };
}

/**
 * v3 流式接口返回的是一串 JSON（可能是换行分隔，也可能直接拼接）。
 * 这里按大括号配对扫描，避免依赖换行——供应商两种格式都出现过。
 */
export function extractJsonObjects(raw: string): JsonChunk[] {
  const chunks: JsonChunk[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          chunks.push(JSON.parse(raw.slice(start, index + 1)) as JsonChunk);
        } catch {
          // 单块解析失败不中断：其余块仍可能带音频
        }
        start = -1;
      }
    }
  }
  return chunks;
}

/** 从 v3 响应里取出音频字节；失败时给出安全错误码 */
export function decodeTtsAudio(raw: string): Buffer {
  const chunks = extractJsonObjects(raw);
  if (chunks.length === 0) {
    throw new TtsError('TTS_REQUEST_FAILED', '语音合成返回无法解析');
  }
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const code = chunk.code ?? chunk.header?.code ?? chunk.header?.status_code;
    if (typeof code === 'number' && code !== 0 && code !== 20000000) {
      throw new TtsError('TTS_REQUEST_FAILED', `语音合成失败（code=${code}）`);
    }
    if (typeof chunk.data === 'string' && chunk.data.length > 0) {
      parts.push(Buffer.from(chunk.data, 'base64'));
    }
  }
  const audio = Buffer.concat(parts);
  if (audio.length === 0) {
    throw new TtsError('TTS_EMPTY_AUDIO', '语音合成未返回音频');
  }
  return audio;
}

export class VolcTtsClient {
  readonly voiceType: string;
  readonly resourceId: string;
  private readonly apiKey?: string;
  private readonly appId?: string;
  private readonly accessToken?: string;
  private readonly sampleRate: number;
  private readonly speedRatio: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VolcTtsOptions = {}) {
    this.voiceType = options.voiceType?.trim() || VOLC_TTS_DEFAULT_VOICE;
    this.resourceId = options.resourceId?.trim() || inferResourceId(this.voiceType);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.appId = options.appId?.trim() || undefined;
    this.accessToken = options.accessToken?.trim() || undefined;
    this.sampleRate = options.sampleRate ?? 24_000;
    this.speedRatio = options.speedRatio ?? 1;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 未配置任何凭据时，前端隐藏「听一听」，不放无效控件 */
  get available(): boolean {
    return Boolean(this.apiKey || (this.appId && this.accessToken));
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.available) throw new TtsError('TTS_NOT_CONFIGURED', '语音合成未配置');
    const content = text.trim();
    if (content.length === 0) throw new TtsError('TTS_REQUEST_FAILED', '合成文本为空');
    const clipped = content.slice(0, VOLC_TTS_MAX_TEXT);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Resource-Id': this.resourceId,
      'X-Api-Request-Id': randomUUID(),
    };
    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey;
    } else {
      headers['X-Api-App-Id'] = this.appId!;
      headers['X-Api-Access-Key'] = this.accessToken!;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(VOLC_TTS_ENDPOINT, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          user: { uid: 'zhiban-health-h5' },
          req_params: {
            text: clipped,
            speaker: this.voiceType,
            audio_params: {
              format: 'mp3',
              sample_rate: this.sampleRate,
              speed_ratio: this.speedRatio,
            },
          },
        }),
      });
    } catch {
      throw new TtsError('TTS_REQUEST_FAILED', '语音合成请求失败');
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new TtsError('TTS_REQUEST_FAILED', `语音合成 HTTP ${response.status}`);
    }
    return decodeTtsAudio(raw);
  }
}

/** 从环境变量构造；缺凭据时 available=false，上层据此关闭朗读入口 */
export function volcTtsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<VolcTtsOptions, 'apiKey' | 'appId' | 'accessToken'> = {},
): VolcTtsClient {
  return new VolcTtsClient({
    ...options,
    apiKey: env.VOLC_TTS_API_KEY,
    appId: env.VOLC_TTS_APPID,
    accessToken: env.VOLC_TTS_ACCESS_TOKEN ?? env.VOLC_TTS_TOKEN,
    ...(env.VOLC_TTS_VOICE_TYPE ? { voiceType: env.VOLC_TTS_VOICE_TYPE } : {}),
    ...(env.VOLC_TTS_RESOURCE_ID ? { resourceId: env.VOLC_TTS_RESOURCE_ID } : {}),
  });
}

/**
 * 磁盘缓存：同一篇文章 + 同一音色只合成一次。
 *
 * - 文件名是 sha256(音色 + 文本)，不含标题内容，不会把文章名写进磁盘路径；
 * - 并发请求共用同一个 Promise，避免重复计费；
 * - 落盘失败不影响本次播放。
 */
export class TtsAudioCache {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileName(voiceType: string, text: string): string {
    return `${createHash('sha256').update(`${voiceType}\u0000${text}`).digest('hex')}.mp3`;
  }

  async getOrCreate(
    voiceType: string,
    text: string,
    produce: () => Promise<Buffer>,
  ): Promise<Buffer> {
    const name = this.fileName(voiceType, text);
    const path = join(this.dir, name);

    const cached = await readFile(path).catch(() => undefined);
    if (cached && cached.length > 0) return cached;

    const existing = this.inflight.get(name);
    if (existing) return existing;

    const pending = (async () => {
      const audio = await produce();
      if (audio.length === 0) throw new TtsError('TTS_EMPTY_AUDIO', '语音合成未返回音频');
      try {
        await mkdir(this.dir, { recursive: true });
        const temp = join(this.dir, `.${name}.${randomUUID()}.tmp`);
        await writeFile(temp, audio, { mode: 0o640 });
        await rename(temp, path);
      } catch {
        // 缓存失败不影响本次播放；下次请求再试
      }
      return audio;
    })();

    this.inflight.set(name, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(name);
    }
  }
}
