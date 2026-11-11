import type { Alert, AlertKind } from '../../mock/alerts.ts';

export interface RelatedFlowTarget {
  kind: 'draft' | 'patient';
  id: string;
  label: string;
  path: string;
}

/**
 * 告警详情里的「查看关联记录」目标：
 * - 有草稿：直接打开该草稿的服务流详情，不再落到列表首页
 * - 只有患者：按患者筛选服务流
 * - 都没有：返回 null，由界面说明无法定位
 */
export function relatedFlowTarget(alert: Alert): RelatedFlowTarget | null {
  if (alert.draftId) {
    return {
      kind: 'draft',
      id: alert.draftId,
      label: '打开关联草稿',
      path: `/service-flow?draftId=${encodeURIComponent(alert.draftId)}`,
    };
  }
  if (alert.patientId) {
    return {
      kind: 'patient',
      id: alert.patientId,
      label: '查看该患者服务记录',
      path: `/service-flow?patientId=${encodeURIComponent(alert.patientId)}`,
    };
  }
  return null;
}

const REASONS: Record<AlertKind, string> = {
  misroute:
    '顾问实际发送的群与草稿目标群不一致，系统在会话存档里匹配到了别的群，因此判定为发错群。',
  unverified:
    '顾问点了「已发送」，但系统回读会话存档时没有找到对应正文。可能是没真正发送、发到了别的群，或存档尚未同步。',
  timeout_remind: '草稿推送给顾问后 15 分钟仍未处理，系统发出提醒。',
  timeout_escalate: '草稿长时间未处理，超过升级时限后转给主管。',
  escalate: '草稿长时间未处理，已升级给主管跟进。',
  dead_letter: '草稿多次推送失败，已进入死信队列，顾问没有收到卡片。',
  advisor_paused: '顾问连续发错群达到阈值，系统自动暂停向该顾问推送草稿。',
  redline: '草稿命中了健康红线规则（如诊断、用药或疗效承诺），发送前需要人工复核。',
};

/** 告警机制说明；具体触发细节仍以 message 为准 */
export function alertReason(kind: AlertKind): string {
  return REASONS[kind] ?? '系统根据服务流状态自动生成该告警。';
}

const GUIDANCE: Record<AlertKind, string> = {
  misroute:
    '先核对实际发送群与目标群，确认客户是否收到错误内容；在服务流打开关联草稿查看实发记录，必要时补发正确内容，再标记已处理。',
  unverified:
    '先确认顾问是否真的发送。存档有分钟级延迟且只保留 5 天，可在关联草稿的证据链里核对；确认未发就提醒补发，确认已发再标记已处理。',
  timeout_remind: '提醒顾问尽快处理草稿；超过 60 分钟会升级给主管。',
  timeout_escalate:
    '主管确认草稿是否还需要发送；队列被阻塞时在告警里释放队列，或恢复/改派顾问后继续服务。',
  escalate: '主管确认草稿是否还需要发送；阻塞时释放队列，或恢复/改派顾问后继续服务。',
  dead_letter:
    '检查顾问是否已和机器人建立 1:1 会话、机器人长连接与网络是否正常；修复后释放队列重试。',
  advisor_paused:
    '先排查错群原因（群改名、绑定错误、顾问操作）；确认后恢复接单，恢复会清零连续错群计数。',
  redline: '人工复核草稿是否涉及诊断、调药或疗效承诺；改写或拦截后再发送。',
};

/** 未处理时的建议动作，帮助处理人知道下一步做什么 */
export function alertGuidance(kind: AlertKind): string {
  return GUIDANCE[kind] ?? '核对关联草稿与服务流记录，处理完成后填写备注。';
}
