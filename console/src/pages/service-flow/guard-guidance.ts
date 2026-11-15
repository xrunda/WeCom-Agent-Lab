/**
 * 草稿命中红线时告诉管理员：风险话术到客户手上没有。
 * 管理员最关心的是「还来不来得及拦」，而不是草稿状态本身。
 */
export function guardRiskSituation(status: string): string {
  switch (status) {
    case 'QUEUED':
    case 'PUSHED':
    case 'ACKNOWLEDGED':
      return '这条草稿还没按原样发出去，先提醒顾问不要照草稿发送。';
    case 'MISROUTE_ALERT':
      return '草稿发到了别的群，风险话术可能已经出现在不该出现的群里。';
    case 'UNVERIFIED':
      return '顾问标记了已发送，但存档里没找到原文，风险话术是否到客户还没确认。';
    case 'EDIT_SENT':
      return '顾问已经改后发出，系统没取到实发原文，风险话术可能已经到客户。';
    case 'VERIFIED':
      return '草稿已按原样发出，风险话术已经到客户。';
    default:
      return '系统还没有核验这条草稿是否发出。';
  }
}

/** 处理一条草稿红线时给管理员的下一步，按有没有处理权限区分。 */
export function guardNextStep(canResolve: boolean): string {
  return canResolve
    ? '下一步：看「草稿版本」确认风险话术；到企微群和顾问确认客户实际收到什么，必要时让顾问补充纠正；确认后点「核实并关闭」记录处理经过。'
    : '下一步：到企微群和顾问确认客户实际收到什么，必要时让顾问补充纠正。记录处理结果需要管理员权限。';
}
