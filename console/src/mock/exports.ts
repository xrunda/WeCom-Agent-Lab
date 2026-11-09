/**
 * #59 服务端 PDF 下载。
 *
 * 真实模式：直接请求 `/zhiban/api/...` 下载服务端生成的 PDF（不经过 JSON 解析）。
 * mock 模式：前端无法生成带中文字体的 PDF，明确抛 `MOCK_ONLY`，
 * 页面据此提示「演示模式不生成 PDF」，绝不伪造下载成功。
 */
import { API_BASE, ApiError, isMockMode } from './http.ts';

export const MOCK_EXPORT_NOTICE =
  '演示模式不生成服务端 PDF；真实部署下将下载由服务器生成的 PDF（含存档原文、版本与核验结果）。';

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

async function download(path: string, fallbackName: string): Promise<string> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    throw new ApiError(
      payload?.error?.code || 'INTERNAL',
      payload?.error?.message || `导出失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return name;
}

/** GET /drafts/{draftId}/evidence.pdf */
export async function exportDraftEvidencePdf(draftId: string): Promise<string> {
  if (isMockMode) throw new ApiError('MOCK_ONLY', MOCK_EXPORT_NOTICE, 501);
  return download(
    `/drafts/${encodeURIComponent(draftId)}/evidence.pdf`,
    `evidence-${safeName(draftId)}.pdf`,
  );
}

/** GET /patients/{id}/records.pdf?from=&to= */
export async function exportPatientRecordsPdf(
  patientId: string,
  range: { from?: number; to?: number } = {},
): Promise<string> {
  if (isMockMode) throw new ApiError('MOCK_ONLY', MOCK_EXPORT_NOTICE, 501);
  const query = new URLSearchParams();
  if (range.from !== undefined) query.set('from', String(range.from));
  if (range.to !== undefined) query.set('to', String(range.to));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return download(
    `/patients/${encodeURIComponent(patientId)}/records.pdf${suffix}`,
    `records-${safeName(patientId)}.pdf`,
  );
}

export function isMockOnly(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'MOCK_ONLY';
}
