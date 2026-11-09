import type { PermissionMatrix, Role } from '../types.ts';

/** 账号页与数据安全页共用的角色元信息 */
export const ROLE_META: Record<Role, { label: string; color: string }> = {
  admin: { label: '机构管理员', color: 'magenta' },
  supervisor: { label: '主管', color: 'blue' },
  viewer: { label: '只读', color: 'default' },
};

export interface PermissionRow {
  group: string;
  key: string;
  label: string;
}

/** 控制台权限的中文口径；与 docs/P1-api.md 的权限矩阵保持一致 */
export const PERMISSION_ROWS: PermissionRow[] = [
  { group: '客户与群', key: 'patient.read', label: '查看客户档案' },
  { group: '客户与群', key: 'patient.write', label: '编辑客户档案' },
  { group: '客户与群', key: 'group.read', label: '查看服务群' },
  { group: '客户与群', key: 'group.write', label: '管理服务群' },
  { group: '客户与群', key: 'advisor.read', label: '查看顾问' },
  { group: '客户与群', key: 'advisor.write', label: '管理顾问' },
  { group: '客户与群', key: 'advisor.pause', label: '暂停顾问' },
  { group: '服务流与告警', key: 'draft.read', label: '查看草稿与服务流' },
  { group: '服务流与告警', key: 'draft.export', label: '导出证据链' },
  { group: '服务流与告警', key: 'alert.read', label: '查看告警' },
  { group: '服务流与告警', key: 'alert.write', label: '处理告警' },
  { group: '知识与规则', key: 'knowledge.read', label: '查看知识库' },
  { group: '知识与规则', key: 'knowledge.write', label: '维护知识库' },
  { group: '知识与规则', key: 'rule.read', label: '查看风险规则' },
  { group: '知识与规则', key: 'rule.write', label: '维护关键词规则' },
  { group: '知识与规则', key: 'script.read', label: '查看话术库' },
  { group: '报表与技能', key: 'report.read', label: '查看数据报表' },
  { group: '报表与技能', key: 'skill.read', label: '查看技能市场' },
  { group: '报表与技能', key: 'solution.read', label: '查看行业方案包' },
  { group: '设置与账号', key: 'setting.read', label: '查看系统设置' },
  { group: '设置与账号', key: 'setting.write', label: '修改系统设置' },
  { group: '设置与账号', key: 'account.read', label: '查看账号' },
  { group: '设置与账号', key: 'account.write', label: '管理账号' },
  { group: '审计与安全', key: 'audit.read', label: '查看审计日志' },
  { group: '审计与安全', key: 'audit.export', label: '导出审计日志' },
  { group: '审计与安全', key: 'security.read', label: '查看数据与安全' },
  { group: '开通与体验', key: 'onboarding.read', label: '查看开通信息' },
  { group: '开通与体验', key: 'onboarding.write', label: '提交开通申请' },
  { group: '开通与体验', key: 'sandbox.use', label: '使用体验中心' },
  { group: '开通与体验', key: 'media.read', label: '查看图片媒体' },
  { group: '开通与体验', key: 'sse.read', label: '订阅实时事件' },
];

export function roleHas(
  role: Pick<PermissionMatrix['roles'][number], 'permissions'>,
  key: string,
): boolean {
  if (role.permissions.includes('*') || role.permissions.includes(key)) return true;
  // 契约示例里的等价权限名
  if (key === 'advisor.write' && role.permissions.includes('advisor.operate')) return true;
  if (key === 'audit.export' && role.permissions.includes('export')) return true;
  return false;
}

/** 角色可执行操作的中文清单；admin 返回 null 表示全部权限 */
export function roleCapabilities(permissions: string[]): string[] | null {
  if (permissions.includes('*')) return null;
  return PERMISSION_ROWS.filter((row) => roleHas({ permissions }, row.key)).map(
    (row) => row.label,
  );
}
