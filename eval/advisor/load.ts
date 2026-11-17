/**
 * 顾问 Agent 评测集加载与校验（#167 §13）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdvisorEvalCase } from './types.ts';

export const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));

export function loadCases(baseDir = EVAL_ROOT): AdvisorEvalCase[] {
  const raw = JSON.parse(
    readFileSync(resolve(baseDir, 'cases/v1.json'), 'utf8'),
  ) as unknown;
  if (!Array.isArray(raw)) throw new Error('评测案例必须是数组');
  const cases = raw.map((item) => assertCase(item));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`评测案例 id 重复: ${item.id}`);
    ids.add(item.id);
  }
  if (cases.length !== 12) throw new Error(`v1 应恰好 12 条，实际 ${cases.length}`);
  return cases;
}

function assertCase(value: unknown): AdvisorEvalCase {
  if (typeof value !== 'object' || value === null) throw new Error('评测案例必须是对象');
  const item = value as Record<string, unknown>;
  const required = ['id', 'message', 'expectTool', 'expectArgs', 'expectStatus', 'requireText', 'forbidText'];
  for (const key of required) {
    if (!(key in item)) throw new Error(`评测案例缺少字段 ${key}`);
  }
  if (
    item.expectTool !== 'advisor_overview' &&
    item.expectTool !== 'advisor_search' &&
    item.expectTool !== 'advisor_get' &&
    item.expectTool !== 'patient_chronic' &&
    item.expectTool !== 'patient_meals' &&
    item.expectTool !== 'patient_meal_photo'
  ) {
    throw new Error(`expectTool 非法: ${String(item.id)}`);
  }
  if (!Array.isArray(item.requireText) || !Array.isArray(item.forbidText)) {
    throw new Error(`requireText / forbidText 必须是数组: ${String(item.id)}`);
  }
  return item as unknown as AdvisorEvalCase;
}
