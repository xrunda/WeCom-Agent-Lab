/**
 * 腾讯云一句话识别（SentenceRecognition）客户端。
 *
 * 设计要点：
 * - 只做一件事：给一段音频字节，返回转写文本；不落盘、不记日志、不缓存。
 * - 凭据从环境变量注入（systemd EnvironmentFile），不在代码或仓库里出现。
 * - 手写 TC3-HMAC-SHA256 签名，避免为一个接口引入整包 SDK。
 * - 音频格式由调用方给出；企微语音是 SILK（含 0x02 头），实测可直接识别。
 */
import { createHash, createHmac } from 'node:crypto';

export interface TencentAsrConfig {
  secretId: string;
  secretKey: string;
  /** 默认 ap-shanghai */
  region?: string;
  /** 默认 asr.tencentcloudapi.com */
  endpoint?: string;
  /** 单次请求超时，默认 15s */
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

export type AsrVoiceFormat = 'silk' | 'wav' | 'pcm' | 'mp3' | 'm4a' | 'aac' | 'amr' | 'ogg-opus' | 'speex';

export class AsrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
  }
}

const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_ENDPOINT = 'asr.tencentcloudapi.com';
const DEFAULT_TIMEOUT_MS = 15_000;
/** 官方限制：Base64 后不超过 3 MB */
const MAX_BASE64_BYTES = 3 * 1024 * 1024;

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

/**
 * 按文件头判断语音格式。
 * 企微存档里的语音实测是 AMR（`#!AMR`）；部分客户端/场景是 SILK。
 * 判断不了直接报错，不把未知字节丢给云端。
 */
export function detectVoiceFormat(audio: Buffer): AsrVoiceFormat {
  const head = audio.subarray(0, 12).toString('latin1');
  if (head.startsWith('#!AMR\n') || head.startsWith('#!AMR-WB\n')) return 'amr';
  if (head.startsWith('#!SILK_V3') || (audio[0] === 0x02 && head.slice(1).startsWith('#!SILK_V3'))) {
    return 'silk';
  }
  if (head.startsWith('RIFF') && audio.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (audio.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (head.startsWith('ID3') || (audio[0] === 0xff && (audio[1] ?? 0) >= 0xe0)) return 'mp3';
  throw new AsrError('ASR_UNKNOWN_FORMAT', '无法识别的语音格式');
}

export class TencentAsrClient {
  private readonly config: Required<Omit<TencentAsrConfig, 'fetchImpl'>>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TencentAsrConfig) {
    this.config = {
      secretId: config.secretId.trim(),
      secretKey: config.secretKey.trim(),
      region: config.region?.trim() || DEFAULT_REGION,
      endpoint: config.endpoint?.trim() || DEFAULT_ENDPOINT,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** 凭据是否齐备；缺省时上层应保持语音消息「不处理」的旧行为 */
  get available(): boolean {
    return this.config.secretId !== '' && this.config.secretKey !== '';
  }

  async transcribe(audio: Buffer, format?: AsrVoiceFormat): Promise<string> {
    if (!this.available) {
      throw new AsrError('ASR_NOT_CONFIGURED', '未配置腾讯云 ASR 凭据');
    }
    if (audio.length === 0) {
      throw new AsrError('ASR_EMPTY_AUDIO', '音频为空');
    }

    const data = audio.toString('base64');
    if (data.length > MAX_BASE64_BYTES) {
      throw new AsrError('ASR_TOO_LARGE', '音频超过 3 MB 上限');
    }

    const voiceFormat = format ?? detectVoiceFormat(audio);

    const payload = JSON.stringify({
      EngSerViceType: '16k_zh',
      SourceType: 1,
      VoiceFormat: voiceFormat,
      Data: data,
      DataLen: audio.length,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const contentType = 'application/json; charset=utf-8';
    const signedHeaders = 'content-type;host';
    const canonicalHeaders = `content-type:${contentType}\nhost:${this.config.endpoint}\n`;
    const credentialScope = `${date}/asr/tc3_request`;
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256hex(
        ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n'),
      ),
    ].join('\n');

    const kDate = hmac(`TC3${this.config.secretKey}`, date);
    const kService = hmac(kDate, 'asr');
    const kSigning = hmac(kService, 'tc3_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization =
      `TC3-HMAC-SHA256 Credential=${this.config.secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`https://${this.config.endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': contentType,
          'X-TC-Action': 'SentenceRecognition',
          'X-TC-Version': '2019-06-14',
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': this.config.region,
        },
        body: payload,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AsrError('ASR_NETWORK', `语音识别请求失败：${detail}`);
    }

    if (!response.ok) {
      throw new AsrError('ASR_HTTP', `语音识别 HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AsrError('ASR_BAD_RESPONSE', '语音识别返回的不是 JSON');
    }

    const result = (body as { Response?: { Result?: unknown; Error?: { Code?: unknown; Message?: unknown } } })
      ?.Response;
    if (result?.Error) {
      const code = typeof result.Error.Code === 'string' ? result.Error.Code : 'UNKNOWN';
      const message = typeof result.Error.Message === 'string' ? result.Error.Message : '';
      throw new AsrError(`ASR_${code}`, message || code);
    }
    if (typeof result?.Result !== 'string') {
      throw new AsrError('ASR_BAD_RESPONSE', '语音识别返回缺少 Result');
    }

    return result.Result.trim();
  }
}

/** 从环境变量构造；缺凭据时 available=false，上层据此关闭语音识别 */
export function tencentAsrFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): TencentAsrClient {
  return new TencentAsrClient({
    secretId: env.TENCENT_ASR_SECRET_ID ?? '',
    secretKey: env.TENCENT_ASR_SECRET_KEY ?? '',
    region: env.TENCENT_ASR_REGION,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}
