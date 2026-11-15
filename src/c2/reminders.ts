/**
 * 1:1 提醒的去重窗口。
 *
 * 提醒只发顾问本人，同一件事短期内重复出现（改稿逐版命中、连续踩同一组红线）
 * 时不连发。窗口按 key 计，键由调用方决定（草稿 id / 顾问+群+规则组）。
 *
 * 只放行不落盘：进程重启后窗口清空，最坏情况是多发一条，可以接受。
 */
export class ReminderThrottle {
  private readonly lastAt = new Map<string, number>();
  private readonly repeatMs: number;

  constructor(repeatMs: number) {
    this.repeatMs = repeatMs;
  }

  /** 窗口内第一次放行并占用窗口；窗口内再问返回 false */
  allow(key: string, now: number): boolean {
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.repeatMs) return false;
    this.lastAt.set(key, now);
    return true;
  }

  /** 发送失败时回退窗口，下一次还要提醒 */
  release(key: string): void {
    this.lastAt.delete(key);
  }
}
