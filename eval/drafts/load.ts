/**
 * #64 评测集加载与基本校验。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EvalCase, ImageEvalCase, TextEvalCase } from './types.ts';

export const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function assertCase(value: unknown): EvalCase {
  if (typeof value !== 'object' || value === null) throw new Error('评测案例必须是对象');
  const item = value as Record<string, unknown>;
  const required = ['id', 'kind', 'category', 'message', 'expectedPoints', 'forbidden'];
  for (const key of required) {
    if (!(key in item)) throw new Error(`评测案例缺少字段 ${key}: ${JSON.stringify(item.id)}`);
  }
  if (item.kind !== 'text' && item.kind !== 'image') {
    throw new Error(`评测案例 kind 非法: ${String(item.id)}`);
  }
  if (!Array.isArray(item.expectedPoints) || !Array.isArray(item.forbidden)) {
    throw new Error(`评测案例 expectedPoints / forbidden 必须是数组: ${String(item.id)}`);
  }
  if (item.kind === 'image' && typeof item.image !== 'string') {
    throw new Error(`图片案例缺少 image: ${String(item.id)}`);
  }
  return item as unknown as EvalCase;
}

export function loadCases(baseDir = EVAL_ROOT): EvalCase[] {
  const text = readJson<unknown[]>(resolve(baseDir, 'cases/text.json')).map(assertCase);
  const images = readJson<unknown[]>(resolve(baseDir, 'cases/images.json')).map(assertCase);
  const all = [...text, ...images];
  const ids = new Set<string>();
  for (const item of all) {
    if (ids.has(item.id)) throw new Error(`评测案例 id 重复: ${item.id}`);
    ids.add(item.id);
  }
  return all;
}

export function splitCases(cases: EvalCase[]): { text: TextEvalCase[]; images: ImageEvalCase[] } {
  return {
    text: cases.filter((item): item is TextEvalCase => item.kind === 'text'),
    images: cases.filter((item): item is ImageEvalCase => item.kind === 'image'),
  };
}

export function assertDatasetSize(cases: EvalCase[]): void {
  const { text, images } = splitCases(cases);
  if (text.length !== 50) throw new Error(`文本案例应为 50 条，实际 ${text.length}`);
  if (images.length !== 10) throw new Error(`图片案例应为 10 条，实际 ${images.length}`);
  const counts = new Map<string, number>();
  for (const item of images) counts.set(item.imageKind, (counts.get(item.imageKind) ?? 0) + 1);
  const expected: Record<string, number> = { meal: 6, report: 2, medicine: 1, other: 1 };
  for (const [kind, count] of Object.entries(expected)) {
    if ((counts.get(kind) ?? 0) !== count) {
      throw new Error(`图片案例 ${kind} 应为 ${count} 条，实际 ${counts.get(kind) ?? 0}`);
    }
  }
}
