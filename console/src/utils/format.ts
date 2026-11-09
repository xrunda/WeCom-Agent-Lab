/** 控制台页面共用的格式化与派生计算（WP-K 新增，其他前端包可复用）。 */

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateTime(ts?: number | null): string {
  if (!ts) return '-';
  return dateTimeFormatter.format(new Date(ts)).replace(/\//g, '-');
}

export function formatDate(ts?: number | null): string {
  if (!ts) return '-';
  return dateFormatter.format(new Date(ts)).replace(/\//g, '-');
}

/** 陪伴天数：不足一天按 1 天计，避免出现「0 天」。 */
export function daysSince(ts: number, now = Date.now()): number {
  return Math.max(1, Math.floor((now - ts) / 86_400_000) + 1);
}

export function formatRelative(ts?: number | null, now = Date.now()): string {
  if (!ts) return '暂无互动';
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(ts);
}

export function formatMoney(yuan: number): string {
  return `¥${yuan.toLocaleString('zh-CN')}`;
}

/** 把日期时间字符串（datetime-local）转成时间戳；非法输入返回 NaN。 */
export function parseDateTimeInput(value: string): number {
  return new Date(value).getTime();
}
