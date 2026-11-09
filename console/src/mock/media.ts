/**
 * 媒体 mock：P1 不引用外网图片，mock 模式统一返回内联 SVG 占位图。
 * 真实模式下图片地址走带鉴权的 /media/{mediaId}，前端不接触磁盘路径。
 */
import { API_BASE, ApiError, isMockMode } from './http.ts';

export type MediaKind =
  | 'image'
  | 'meal'
  | 'report'
  | 'medicine'
  | 'voice'
  | 'file'
  | 'video';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  url: string;
  label: string;
}

const KIND_STYLE: Record<
  MediaKind,
  { bg: string; accent: string; ink: string; glyph: string; label: string }
> = {
  image: { bg: '#f5f3ff', accent: '#8b5cf6', ink: '#4c1d95', glyph: '图', label: '图片' },
  meal: { bg: '#fff7ed', accent: '#f59e0b', ink: '#7c2d12', glyph: '餐', label: '餐食' },
  report: { bg: '#eff6ff', accent: '#3b82f6', ink: '#1e3a8a', glyph: '报', label: '报告' },
  medicine: { bg: '#f0fdf4', accent: '#22c55e', ink: '#14532d', glyph: '药', label: '药品' },
  voice: { bg: '#fef2f2', accent: '#ef4444', ink: '#7f1d1d', glyph: '音', label: '语音' },
  file: { bg: '#f8fafc', accent: '#64748b', ink: '#334155', glyph: '文', label: '文件' },
  video: { bg: '#fdf4ff', accent: '#d946ef', ink: '#701a75', glyph: '视', label: '视频' },
};

/** 生成内联 SVG 占位图；同一 mediaId 颜色稳定，截图和测试可重复 */
export function mockMediaDataUri(kind: MediaKind, label?: string): string {
  const style = KIND_STYLE[kind];
  const text = label ?? style.label;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="${style.bg}"/>
  <rect x="28" y="28" width="264" height="184" rx="18" fill="#ffffff" stroke="${style.accent}" stroke-width="3" stroke-dasharray="10 7"/>
  <circle cx="160" cy="96" r="34" fill="${style.accent}" opacity="0.16"/>
  <text x="160" y="110" font-size="34" text-anchor="middle" fill="${style.ink}" font-family="PingFang SC, Hiragino Sans GB, sans-serif" font-weight="700">${style.glyph}</text>
  <text x="160" y="158" font-size="18" text-anchor="middle" fill="${style.ink}" font-family="PingFang SC, Hiragino Sans GB, sans-serif">${escapeXml(text)}</text>
  <text x="160" y="184" font-size="12" text-anchor="middle" fill="${style.ink}" opacity="0.66" font-family="PingFang SC, Hiragino Sans GB, sans-serif">示例图片 · 非真实照片</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 页面里给 <img src> 用的地址；mock 模式不请求后端 */
export function mediaUrl(mediaId: string, kind: MediaKind = 'image', label?: string): string {
  if (!isMockMode) return `${API_BASE}/media/${mediaId}`;
  return mockMediaDataUri(kind, label);
}

export function mediaKindLabel(kind: MediaKind): string {
  return KIND_STYLE[kind].label;
}

export interface UploadedMedia {
  mediaId: string;
  url: string;
  width: number;
  height: number;
  size: number;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 沙盒上传：真实模式走 multipart；mock 模式转成 data URL 供顾问手机预览 */
export async function uploadSandboxImage(file: File): Promise<UploadedMedia> {
  if (file.size > 10 * 1024 * 1024) {
    throw new ApiError('VALIDATION_FAILED', '图片不能超过 10 MB', 422);
  }
  if (!/^image\/(jpeg|png)$/.test(file.type)) {
    throw new ApiError('VALIDATION_FAILED', '只支持 JPG / PNG 图片', 422);
  }

  if (isMockMode) {
    const url = await fileToDataUrl(file);
    return {
      mediaId: `med_sbx_${Date.now()}`,
      url,
      width: 0,
      height: 0,
      size: file.size,
    };
  }

  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${API_BASE}/sandbox/uploads`, {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const payload = (await response.json().catch(() => null)) as
    | UploadedMedia
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    const error = payload && 'error' in payload ? payload.error : undefined;
    throw new ApiError(
      error?.code || 'INTERNAL',
      error?.message || `上传失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return payload as UploadedMedia;
}
