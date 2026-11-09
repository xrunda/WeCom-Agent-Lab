/** 控制台页面共用的格式化与派生计算（各前端工作包共同维护）。 */

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
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

export function formatRelative(
  ts?: number | null,
  now = Date.now(),
  emptyText = '暂无互动',
): string {
  if (!ts) return emptyText;
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

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
