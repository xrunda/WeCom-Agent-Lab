import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_PASSWORD, login, resetMockState } from '../src/mock/api.ts';
import {
  CANONICAL_PERMISSIONS,
  DEMO_ONLY_PERMISSIONS,
  PERMISSION_ROWS,
  permissionsForRole,
} from '../src/utils/permissions.ts';

// vitest 以 console/ 为根目录运行；import.meta.url 在 jsdom 下不是 file: 协议
const SRC_DIR = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function canLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/can\(\s*'([^']+)'\s*\)/g)) {
      const permission = match[1]!;
      const files = found.get(permission) ?? [];
      files.push(file.slice(SRC_DIR.length + 1));
      found.set(permission, files);
    }
  }
  return found;
}

const ALLOWED = new Set<string>([...CANONICAL_PERMISSIONS, ...DEMO_ONLY_PERMISSIONS]);

beforeEach(() => {
  resetMockState();
});

describe('控制台权限名契约', () => {
  it('页面里的 can() 只使用后端认识或已声明的演示权限', () => {
    const unknown = [...canLiterals()]
      .filter(([permission]) => !ALLOWED.has(permission))
      .map(([permission, files]) => `${permission}（${[...new Set(files)].join(', ')}）`);

    // 真实模式 /auth/session 只返回后端权限名；写错名字会让管理员变成只读。
    expect(unknown).toEqual([]);
  });

  it('权限矩阵每一行都能被后端的权限名解释', () => {
    expect(PERMISSION_ROWS.filter((row) => !ALLOWED.has(row.key))).toEqual([]);
  });

  it('mock 管理员的权限覆盖后端全部权限名', async () => {
    const session = await login('admin', MOCK_PASSWORD);

    expect(session.permissions).toEqual(expect.arrayContaining([...CANONICAL_PERMISSIONS]));
  });

  it('主管与只读账号沿用后端权限矩阵', () => {
    expect(permissionsForRole('supervisor')).toContain('advisor.operate');
    expect(permissionsForRole('supervisor')).toContain('export');
    expect(permissionsForRole('viewer')).not.toContain('export');
    expect(permissionsForRole('viewer')).not.toContain('tenant.write');
  });
});
