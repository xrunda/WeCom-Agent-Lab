import type { PermissionMatrix, Role } from '../types.ts';

/** 账号页与数据安全页共用的角色元信息 */
export const ROLE_META: Record<Role, { label: string; color: string }> = {
  admin: { label: '机构管理员', color: 'magenta' },
  supervisor: { label: '主管', color: 'blue' },
  viewer: { label: '只读', color: 'default' },
};

/**
 * 控制台权限名，必须与后端 src/p1/console-types.ts 的 Permission 完全一致。
 *
 * 真实模式下 GET /auth/session 返回的就是这些名字；页面里的 can() 一旦写成
 * 别的名字（例如 setting.write），管理员会被误判成只读账号，按钮和表单全部禁用。
 * console/tests/permissions-contract.test.ts 会扫描 can() 字面量防止漂移。
 */
export const CANONICAL_PERMISSIONS = [
  'tenant.read',
  'tenant.write',
  'patient.read',
  'patient.write',
  'draft.read',
  'alert.read',
  'alert.write',
  'advisor.operate',
  'audit.read',
  'export',
  'account.write',
  'onboarding.submit',
  'onboarding.list',
  'sandbox.use',
] as const;

export type CanonicalPermission = (typeof CANONICAL_PERMISSIONS)[number];

/** 与后端 ROLE_PERMISSIONS 一致；admin 通配全部 */
export const ROLE_CANONICAL_PERMISSIONS: Record<Role, readonly CanonicalPermission[]> = {
  admin: CANONICAL_PERMISSIONS,
  supervisor: [
    'tenant.read',
    'patient.read',
    'patient.write',
    'draft.read',
    'alert.read',
    'alert.write',
    'advisor.operate',
    'audit.read',
    'export',
    'onboarding.submit',
    'sandbox.use',
  ],
  viewer: ['tenant.read', 'patient.read', 'draft.read', 'alert.read', 'audit.read', 'sandbox.use'],
};

/**
 * 仅演示页使用、后端尚无对应路由的权限名。
 * 只授予 mock 管理员，避免把未实现的写操作伪装成真实能力。
 */
export const DEMO_ONLY_PERMISSIONS = ['knowledge.write', 'rule.write'] as const;

/** mock 会话里的 permissions；真实模式由后端返回同样的名字。 */
export function permissionsForRole(role: Role): string[] {
  const permissions: string[] = [...ROLE_CANONICAL_PERMISSIONS[role]];
  if (role === 'admin') permissions.push(...DEMO_ONLY_PERMISSIONS);
  return permissions;
}

export interface PermissionRow {
  group: string;
  key: string;
  label: string;
}

/** 权限矩阵的中文口径；key 与后端权限名一致 */
export const PERMISSION_ROWS: PermissionRow[] = [
  { group: '客户与群', key: 'patient.read', label: '查看客户档案' },
  { group: '客户与群', key: 'patient.write', label: '编辑客户档案' },
  { group: '客户与群', key: 'advisor.operate', label: '暂停 / 恢复顾问' },
  { group: '服务流与告警', key: 'draft.read', label: '查看草稿与服务流' },
  { group: '服务流与告警', key: 'alert.read', label: '查看告警' },
  { group: '服务流与告警', key: 'alert.write', label: '处理告警' },
  { group: '设置与账号', key: 'tenant.read', label: '查看机构设置' },
  { group: '设置与账号', key: 'tenant.write', label: '修改机构设置' },
  { group: '设置与账号', key: 'account.write', label: '管理账号' },
  { group: '审计与导出', key: 'audit.read', label: '查看审计日志' },
  { group: '审计与导出', key: 'export', label: '导出证据链与服务记录' },
  { group: '开通与体验', key: 'onboarding.list', label: '查看开通申请' },
  { group: '开通与体验', key: 'onboarding.submit', label: '提交开通申请' },
  { group: '开通与体验', key: 'sandbox.use', label: '使用体验中心' },
];

export function roleHas(
  role: Pick<PermissionMatrix['roles'][number], 'permissions'>,
  key: string,
): boolean {
  return role.permissions.includes('*') || role.permissions.includes(key);
}

/** 角色可执行操作的中文清单；admin 返回 null 表示全部权限 */
export function roleCapabilities(permissions: string[]): string[] | null {
  if (permissions.includes('*')) return null;
  return PERMISSION_ROWS.filter((row) => roleHas({ permissions }, row.key)).map(
    (row) => row.label,
  );
}
