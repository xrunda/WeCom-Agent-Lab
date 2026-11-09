/** mock 层共用的浏览器存储与查询串工具；真实模式不会用到。 */
export function readStore<T>(key: string, seed: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return cloneSeed(seed);
    return JSON.parse(raw) as T;
  } catch {
    return cloneSeed(seed);
  }
}

export function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式或存储被禁用时不影响当前会话
  }
}

export function removeStore(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

function cloneSeed<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function mockId(prefix: string): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}${random}`;
}

export function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}
