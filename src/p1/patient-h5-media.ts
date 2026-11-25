/**
 * PH5-06（#235）患者照片：类型判定、EXIF 剥离与摘要。
 *
 * 安全约定（PRD §13）：
 * - 类型按魔数判断，扩展名不可信
 * - JPEG 入库前剥离 APP1（Exif，含 GPS/拍摄设备）
 * - 只接受 JPEG / PNG / WebP，单张 ≤10MB
 */
import { createHash } from 'node:crypto';

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export function detectImageMime(buffer: Buffer): ImageMime | null {
  if (buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 剥离 JPEG 中的 APP1（Exif）段。返回新缓冲区与是否真的剥离过。
 * 非 JPEG 原样返回（PNG/WebP 的设备信息风险较低，保留原字节并在元数据里注明）。
 */
export function stripJpegExif(buffer: Buffer): { buffer: Buffer; stripped: boolean } {
  if (detectImageMime(buffer) !== 'image/jpeg') return { buffer, stripped: false };

  const parts: Buffer[] = [buffer.subarray(0, 2)]; // SOI
  let offset = 2;
  let stripped = false;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break; // 遇到非法标记，停止解析，原样保留剩余
    const marker = buffer[offset + 1]!;
    // SOS 之后是压缩数据，直接拷贝剩余全部
    if (marker === 0xda) {
      parts.push(buffer.subarray(offset));
      offset = buffer.length;
      break;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;

    const isExif = marker === 0xe1; // APP1
    if (!isExif) {
      parts.push(buffer.subarray(offset, offset + 2 + length));
    } else {
      stripped = true;
    }
    offset += 2 + length;
  }

  if (offset < buffer.length && parts.length === 1) {
    // 解析没走完（例如异常文件），为保证可用性原样返回
    return { buffer, stripped: false };
  }
  return { buffer: Buffer.concat(parts), stripped };
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface PreparedImage {
  mimeType: ImageMime;
  bytes: number;
  sha256: string;
  exifStripped: boolean;
  data: Buffer;
}

/** 校验 + 剥 Exif + 摘要，一步完成；不合法时返回原因 */
export function prepareImage(
  raw: Buffer,
): { ok: true; image: PreparedImage } | { ok: false; reason: 'TOO_LARGE' | 'UNSUPPORTED' } {
  if (raw.length > IMAGE_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' };
  const mime = detectImageMime(raw);
  if (!mime) return { ok: false, reason: 'UNSUPPORTED' };
  const { buffer, stripped } = stripJpegExif(raw);
  return {
    ok: true,
    image: {
      mimeType: mime,
      bytes: buffer.length,
      sha256: sha256Of(buffer),
      exifStripped: stripped,
      data: buffer,
    },
  };
}
