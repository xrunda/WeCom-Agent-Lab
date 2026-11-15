/**
 * 密码登录数字验证码。
 *
 * 目的：挡住拿密码字典反复试的脚本——每次登录必须同时提交一张服务端签发的图片验证码。
 *
 * - 答案只存在服务端内存，响应里只有渲染好的 PNG（data URL）
 * - 每个验证码一次性有效：无论答对答错，校验后立即作废，避免同一个 id 被反复猜
 * - 2 分钟过期；按 IP 限制发放频率，防止被刷图
 * - 渲染手写位图字模 + zlib 编码 PNG，不引图片依赖，也不依赖系统字体
 *   （用 SVG `<text>` 会把数字写进响应，等于把答案交给脚本）
 */
import { randomInt, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { ConsoleError } from './console-error.ts';

export const CAPTCHA_TTL_MS = 2 * 60 * 1000;
export const CAPTCHA_CODE_LENGTH = 4;

/** 与登录页 large 输入框同高（44px），并排时不用缩放 */
const IMAGE_WIDTH = 132;
const IMAGE_HEIGHT = 44;
/** 同一 IP 的发图窗口：默认 1 分钟 20 张 */
const ISSUE_LIMIT = 20;
const ISSUE_WINDOW_MS = 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_ISSUE_WINDOWS = 2048;

export interface CaptchaChallenge {
  /** 一次性 id，登录时随 captchaCode 一起回传 */
  id: string;
  /** data:image/png;base64,... */
  image: string;
  /** 单位秒 */
  expiresIn: number;
}

export interface CaptchaOptions {
  now?: () => number;
  ttlMs?: number;
  codeLength?: number;
  issueLimit?: number;
  issueWindowMs?: number;
  /** 测试注入：返回指定位数的数字串；默认用 crypto 随机 */
  codeGenerator?: (length: number) => string;
  newId?: () => string;
}

interface CaptchaEntry {
  answer: string;
  expiresAt: number;
}

interface IssueWindow {
  count: number;
  windowStart: number;
}

/**
 * 5x7 点阵数字。值里的 `1` 是笔画；渲染时按整数倍放大，
 * 不做抗锯齿，避免边缘被平滑后反而更难辨认。
 */
const DIGIT_GLYPHS: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/** 笔画颜色：都足够深，在浅灰底上对比度高；几档接近的颜色只是让每张图不完全一样 */
const INK_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [31, 41, 55],
  [30, 58, 95],
  [51, 51, 64],
];

function randomDigits(length: number): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

/** 画一条线段（含端点），用于干扰线；点是离散采样，不需要抗锯齿 */
function drawLine(
  pixels: Buffer,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number],
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  }
}

/** 把验证码渲染成 24 位 RGB 位图；每个数字有轻微的位置抖动和错切 */
function renderPixels(code: string): Buffer {
  const pixels = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 3);
  for (let y = 0; y < IMAGE_HEIGHT; y += 1) {
    for (let x = 0; x < IMAGE_WIDTH; x += 1) {
      const noise = randomInt(-4, 5);
      const offset = (y * IMAGE_WIDTH + x) * 3;
      pixels[offset] = clampByte(244 + noise);
      pixels[offset + 1] = clampByte(246 + noise);
      pixels[offset + 2] = clampByte(249 + noise);
    }
  }

  // 先画两条浅色干扰线，再写数字，避免线盖住笔画
  for (let line = 0; line < 2; line += 1) {
    drawLine(
      pixels,
      IMAGE_WIDTH,
      IMAGE_HEIGHT,
      4,
      randomInt(6, IMAGE_HEIGHT - 6),
      IMAGE_WIDTH - 4,
      randomInt(6, IMAGE_HEIGHT - 6),
      [196, 203, 214],
    );
  }

  const scale = 4;
  const glyphWidth = 5 * scale;
  const glyphHeight = 7 * scale;
  const step = 25;
  const startX = Math.max(4, Math.floor((IMAGE_WIDTH - code.length * step) / 2) + 2);

  for (let index = 0; index < code.length; index += 1) {
    const glyph = DIGIT_GLYPHS[code[index]!];
    if (!glyph) continue;
    const ink = INK_COLORS[randomInt(0, INK_COLORS.length)]!;
    const baseX = startX + index * step + randomInt(-1, 2);
    const baseY = Math.floor((IMAGE_HEIGHT - glyphHeight) / 2) + randomInt(-2, 3);
    // 轻微错切：越靠上的行越往右偏，模拟手写角度
    const shear = randomInt(0, 3) / 10;

    for (let row = 0; row < 7; row += 1) {
      const pattern = glyph[row]!;
      for (let column = 0; column < 5; column += 1) {
        if (pattern[column] !== '1') continue;
        const skew = Math.round((3 - row) * shear);
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = baseX + column * scale + dx + skew;
            const y = baseY + row * scale + dy;
            if (x < 0 || x >= IMAGE_WIDTH || y < 0 || y >= IMAGE_HEIGHT) continue;
            const offset = (y * IMAGE_WIDTH + x) * 3;
            pixels[offset] = ink[0];
            pixels[offset + 1] = ink[1];
            pixels[offset + 2] = ink[2];
          }
        }
      }
    }
  }

  // 散点噪声，密度不高，主要防简单模板匹配
  for (let dot = 0; dot < 90; dot += 1) {
    const x = randomInt(0, IMAGE_WIDTH);
    const y = randomInt(0, IMAGE_HEIGHT);
    const shade = randomInt(150, 211);
    const offset = (y * IMAGE_WIDTH + x) * 3;
    pixels[offset] = shade;
    pixels[offset + 1] = shade;
    pixels[offset + 2] = shade;
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 8 位真彩色（color type 2）PNG；每行前加一个 filter 字节 0 */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    rgb.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderImage(code: string): string {
  const png = encodePng(IMAGE_WIDTH, IMAGE_HEIGHT, renderPixels(code));
  return `data:image/png;base64,${png.toString('base64')}`;
}

export class CaptchaService {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly codeLength: number;
  private readonly issueLimit: number;
  private readonly issueWindowMs: number;
  private readonly codeGenerator: (length: number) => string;
  private readonly newId: () => string;

  /** 验证码答案；Map 保持插入顺序，超上限时淘汰最旧的 */
  private readonly entries = new Map<string, CaptchaEntry>();
  private readonly issueWindows = new Map<string, IssueWindow>();

  constructor(options: CaptchaOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? CAPTCHA_TTL_MS;
    this.codeLength = options.codeLength ?? CAPTCHA_CODE_LENGTH;
    this.issueLimit = options.issueLimit ?? ISSUE_LIMIT;
    this.issueWindowMs = options.issueWindowMs ?? ISSUE_WINDOW_MS;
    this.codeGenerator = options.codeGenerator ?? randomDigits;
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** 签发一张验证码；同一 IP 超过发放频率抛 RATE_LIMITED */
  issue(ip: string): CaptchaChallenge {
    const now = this.now();
    this.assertIssueAllowed(ip, now);
    this.purge(now);

    const answer = this.codeGenerator(this.codeLength);
    const id = this.newId();
    this.entries.set(id, { answer, expiresAt: now + this.ttlMs });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }

    return { id, image: renderImage(answer), expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  /** 校验并立即作废（一次性）；id 不存在、已过期或答案不对都返回 false */
  verify(id: unknown, code: unknown): boolean {
    if (typeof id !== 'string' || id === '') return false;
    const entry = this.entries.get(id);
    this.entries.delete(id);
    if (!entry || entry.expiresAt <= this.now()) return false;
    const answer = typeof code === 'string' ? code.trim() : '';
    return answer !== '' && answer === entry.answer;
  }

  private assertIssueAllowed(ip: string, now: number): void {
    const current = this.issueWindows.get(ip);
    if (!current || now - current.windowStart >= this.issueWindowMs) {
      this.issueWindows.set(ip, { count: 1, windowStart: now });
      return;
    }
    if (current.count >= this.issueLimit) {
      throw new ConsoleError('RATE_LIMITED', '验证码请求过于频繁，请稍后再试');
    }
    current.count += 1;
  }

  private purge(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    if (this.issueWindows.size <= MAX_ISSUE_WINDOWS) return;
    for (const [ip, window] of this.issueWindows) {
      if (now - window.windowStart >= this.issueWindowMs) this.issueWindows.delete(ip);
    }
  }
}
