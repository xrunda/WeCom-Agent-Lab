/**
 * 回归：控制台 SSE 服务端以命名事件下发（`event: alert.created`），
 * EventSource.onmessage 不会触发。订阅方必须用 addEventListener 按类型注册，
 * 否则真实模式下告警角标 / 沙盒 / 服务流都收不到实时更新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn =
      typeof listener === 'function'
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const set = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    set.add(fn as (event: Event) => void);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    void type;
    void listener;
  }

  dispatch(type: string, data = '{}'): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ type, data } as MessageEvent);
    }
  }

  dispatchUnnamed(data = '{}'): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  open(): void {
    this.onopen?.();
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_MODE', 'real');
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('真实模式 SSE 订阅', () => {
  it('告警订阅接收命名事件，并在重连时刷新', async () => {
    const { subscribeAlerts } = await import('../src/mock/alerts.ts');
    const received = vi.fn();
    const unsubscribe = subscribeAlerts(received);

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain('/stream?types=alert.*');

    source.dispatch('alert.created');
    expect(received).toHaveBeenCalledTimes(1);

    source.dispatch('alert.resolved');
    expect(received).toHaveBeenCalledTimes(2);

    // 断线重连后 onopen 触发一次 REST 校准
    source.open();
    expect(received).toHaveBeenCalledTimes(3);

    // 未命名事件仍然兜底处理
    source.dispatchUnnamed();
    expect(received).toHaveBeenCalledTimes(4);

    unsubscribe();
    expect(source.closed).toBe(true);
  });

  it('沙盒订阅接收 sandbox.* 命名事件', async () => {
    const { subscribeSandbox } = await import('../src/mock/sandbox.ts');
    const received = vi.fn();
    const unsubscribe = subscribeSandbox(received);

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain('/stream?types=sandbox.*');

    source.dispatch('sandbox.draft');
    source.dispatch('sandbox.verification');
    expect(received).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('服务流订阅解析 draft.* 命名事件', async () => {
    const { subscribeServiceFlow } = await import('../src/mock/service-flow.ts');
    const handler = vi.fn();
    const unsubscribe = subscribeServiceFlow(handler);

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain('/stream?types=draft.*');

    source.dispatch(
      'draft.pushed',
      JSON.stringify({ id: 'evt_1', type: 'draft.pushed', at: 1, message: '已推送' }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.event?.id).toBe('evt_1');

    source.dispatch('draft.revised', 'not-json');
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
