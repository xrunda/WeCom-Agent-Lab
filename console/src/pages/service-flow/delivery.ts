/**
 * 「实发正文」空态文案：只在还没发的时候说「尚未发送」。
 * 已发送的草稿取不到存档原文是存档问题，不能说成没发过。
 */
export function deliveryEmptyText(status: string): string {
  switch (status) {
    case 'QUEUED':
    case 'PUSHED':
    case 'ACKNOWLEDGED':
      return '尚未发送，没有实发正文。';
    case 'VERIFIED':
      return '已核对发送，但存档里取不到当时的正文。';
    case 'EDIT_SENT':
      return '顾问已在本群发言（存档确认），但取不到与草稿对应的实发原文。';
    case 'MISROUTE_ALERT':
      return '这条草稿发到了别的群，本群没有实发正文。';
    case 'UNVERIFIED':
      return '顾问标记了已发送，但存档里没有找到对应正文。';
    default:
      return '还没有可展示的实发正文。';
  }
}
