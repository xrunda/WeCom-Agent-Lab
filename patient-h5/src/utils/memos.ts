/**
 * 日历备忘（生日 / 纪念日 / 忌日 / 复查 / 其他）。
 *
 * 目前只存在本机 localStorage：真实跨设备同步需要后端契约，
 * 页面会明确告知「仅保存在本机」。localStorage 不可用时退回内存，不假装已保存。
 */
export type MemoType = 'birthday' | 'anniversary' | 'memorial' | 'checkup' | 'other';

export interface Memo {
  id: string;
  date: string;
  type: MemoType;
  title: string;
  createdAt: number;
}

export const MEMO_LABELS: Record<MemoType, string> = {
  birthday: '生日',
  anniversary: '纪念日',
  memorial: '忌日',
  checkup: '复查',
  other: '其他',
};

const KEY = 'zb_h5_calendar_memos';

let memoryFallback: Memo[] = [];
let storageAvailable: boolean | null = null;

function storage(): Storage | null {
  try {
    const probe = 'zb_probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    storageAvailable = true;
    return window.localStorage;
  } catch {
    storageAvailable = false;
    return null;
  }
}

/** 本机存储是否可用；不可用时页面要如实提示 */
export function memosPersistent(): boolean {
  if (storageAvailable === null) storage();
  return storageAvailable === true;
}

export function loadMemos(): Memo[] {
  const store = storage();
  if (!store) return [...memoryFallback];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Memo =>
        Boolean(item) &&
        typeof (item as Memo).id === 'string' &&
        typeof (item as Memo).date === 'string' &&
        typeof (item as Memo).title === 'string',
    );
  } catch {
    return [];
  }
}

function persist(list: Memo[]): void {
  const store = storage();
  if (!store) {
    memoryFallback = list;
    return;
  }
  try {
    store.setItem(KEY, JSON.stringify(list));
  } catch {
    memoryFallback = list;
  }
}

export function addMemo(input: { date: string; type: MemoType; title: string }): Memo {
  const memo: Memo = {
    id: `memo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    date: input.date,
    type: input.type,
    title: input.title.trim().slice(0, 30),
    createdAt: Date.now(),
  };
  persist([...loadMemos(), memo]);
  return memo;
}

export function removeMemo(id: string): void {
  persist(loadMemos().filter((item) => item.id !== id));
}

export function memosOn(list: Memo[], date: string): Memo[] {
  return list.filter((item) => item.date === date);
}
