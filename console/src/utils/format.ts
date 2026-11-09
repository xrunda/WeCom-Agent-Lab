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

export function formatDateTime(timestamp: number | null | undefined): string {
  if (timestamp == null) return '—';
  return dateTimeFormatter.format(new Date(timestamp)).replace(/\//g, '-');
}

export function formatDate(timestamp: number | null | undefined): string {
  if (timestamp == null) return '—';
  return dateFormatter.format(new Date(timestamp)).replace(/\//g, '-');
}

export function formatRelative(timestamp: number | null | undefined): string {
  if (timestamp == null) return '—';
  const diffSeconds = Math.round((Date.now() - timestamp) / 1000);
  if (diffSeconds < 60) return '刚刚';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`;
  if (diffSeconds < 86_400) return `${Math.floor(diffSeconds / 3600)} 小时前`;
  if (diffSeconds < 7 * 86_400) return `${Math.floor(diffSeconds / 86_400)} 天前`;
  return formatDate(timestamp);
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
