/**
 * 顾问待办里的「未处理告警」映射（#167 / #208 修复）。
 *
 * 事实来源必须是控制台告警：顾问在控制台点「已处理」后，guard 里的旧记录
 * 不会同步状态；如果直接读 guard，待办会一直显示已经处理过的告警。
 * 口径与控制台「质检与告警」页一致：只看 redline（员工发言 / AI 草稿）且 open。
 */
import type { AdvisorAlertView } from './types.ts';

export interface ConsoleAlertLike {
  id: string;
  kind: string;
  severity?: string;
  status: string;
  title: string;
  advisorId?: string | null;
  createdAt: number;
  sandbox?: boolean;
}

/** 控制台告警 → 顾问待办视图；只保留本人名下、未处理、非沙盒的红线告警 */
export function openRedlineAlertsFor(
  items: ConsoleAlertLike[],
  advisorId: string,
): AdvisorAlertView[] {
  return items
    .filter((alert) => alert.kind === 'redline')
    .filter((alert) => alert.status === 'open')
    .filter((alert) => alert.sandbox !== true)
    .filter((alert) => alert.advisorId === advisorId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((alert) => ({
      id: alert.id,
      title: alert.title,
      at: alert.createdAt,
      ...(alert.severity ? { severity: alert.severity } : {}),
    }));
}
