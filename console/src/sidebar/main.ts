/**
 * 侧边栏入口（#145 / #148）。
 *
 * 顺序固定：先出骨架 → JS-SDK 鉴权 → 取当前会话 → 取首屏数据。
 * 401 只静默重试一次，其次显示「登录已失效」，避免和企微授权来回跳。
 * 轮询 30 秒，页面隐藏时暂停，切回立即刷新。
 */
import './sidebar.css';
import { AUTH_START_PATH, SidebarApiError, fetchAgentConfig, fetchContext } from './api.ts';
import { render } from './view.ts';
import type { ViewHandlers } from './view.ts';
import { configureAgent, contextQuery, resolveConversation } from './wecom.ts';
import type { ConversationRef, WxLike } from './wecom.ts';
import type { SidebarState } from './types.ts';

declare global {
  interface Window {
    wx?: WxLike;
  }
}

const POLL_MS = 30_000;
const AUTH_TRIED_KEY = 'zb_sidebar_auth_tried';
const CONSOLE_URL: string | undefined = import.meta.env.VITE_CONSOLE_URL;

const root = document.getElementById('root');
if (root) {
  render(root, { kind: 'loading' });
  void start(root);
}

function consoleUrl(): string | undefined {
  if (!CONSOLE_URL) return undefined;
  // 控制台只在桌面端有意义；手机侧边栏不显示
  if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) {
    return undefined;
  }
  return CONSOLE_URL;
}

function readAuthTried(): boolean {
  try {
    return sessionStorage.getItem(AUTH_TRIED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAuthTried(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(AUTH_TRIED_KEY, '1');
    else sessionStorage.removeItem(AUTH_TRIED_KEY);
  } catch {
    // 隐私模式禁用存储：退化为每次 401 都跳一次授权
  }
}

let conversation: ConversationRef | undefined;
let pollingTimer: number | undefined;

function stopPolling(): void {
  if (pollingTimer !== undefined) {
    window.clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function startPolling(redraw: () => void): void {
  stopPolling();
  pollingTimer = window.setInterval(() => {
    if (document.hidden) return;
    redraw();
  }, POLL_MS);
}

function handleAuthFailure(): void {
  if (!readAuthTried()) {
    writeAuthTried(true);
    location.replace(AUTH_START_PATH);
    return;
  }
  writeAuthTried(false);
  stopPolling();
  if (root) render(root, { kind: 'auth-expired' });
}

async function start(rootEl: HTMLElement): Promise<void> {
  stopPolling();
  conversation = undefined;
  render(rootEl, { kind: 'loading' });

  const wx = window.wx;
  if (!wx) {
    render(rootEl, {
      kind: 'error',
      message: '请在企微聊天窗口里打开侧边栏。',
      retryable: false,
    });
    return;
  }

  try {
    // 只给去掉 hash 的页面地址签名；服务端会拒绝其它来源
    const pageUrl = location.href.split('#')[0] ?? location.href;
    const config = await fetchAgentConfig(pageUrl);
    await configureAgent(wx, config);

    conversation = await resolveConversation(wx);
    if (conversation.kind === 'unsupported') {
      render(rootEl, { kind: 'unsupported', reason: 'NO_CONVERSATION' });
      return;
    }

    await refresh(rootEl);
    startPolling(() => void refresh(rootEl));
  } catch (error) {
    if (error instanceof SidebarApiError && (error.status === 401 || error.status === 403)) {
      if (error.status === 401) handleAuthFailure();
      else {
        render(rootEl, {
          kind: 'error',
          message: '你不是这个会话的负责顾问，暂时看不到这里的数据。',
          retryable: false,
        });
      }
      return;
    }
    render(rootEl, { kind: 'error', message: friendlyMessage(error), retryable: true });
  }
}

let lastData: SidebarState & { kind: 'ready' } | undefined;

function handlers(rootEl: HTMLElement, redraw: () => void): ViewHandlers {
  return {
    onRefresh: redraw,
    onRetry: () => void start(rootEl),
    consoleUrl: consoleUrl(),
  };
}

async function refresh(rootEl: HTMLElement): Promise<void> {
  if (!conversation || conversation.kind === 'unsupported') return;
  const redraw = (): void => void refresh(rootEl);
  try {
    const data = await fetchContext(contextQuery(conversation));
    if (!data.conv.served) {
      stopPolling();
      lastData = undefined;
      render(rootEl, {
        kind: 'unsupported',
        reason:
          data.conv.reason ??
          (conversation.kind === 'dm' ? 'DM_NOT_SUPPORTED' : 'GROUP_NOT_FOUND'),
      });
      return;
    }
    writeAuthTried(false);
    lastData = { kind: 'ready', data };
    render(rootEl, lastData, handlers(rootEl, redraw));
  } catch (error) {
    if (error instanceof SidebarApiError && error.status === 401) {
      handleAuthFailure();
      return;
    }
    if (error instanceof SidebarApiError && error.status === 403) {
      stopPolling();
      render(rootEl, {
        kind: 'error',
        message: '你不是这个会话的负责顾问，暂时看不到这里的数据。',
        retryable: false,
      });
      return;
    }
    if (lastData) {
      // 保留上次内容，只在顶部提示刷新失败
      render(
        rootEl,
        { ...lastData, notice: { message: '刷新失败，正在显示上次的内容', retryable: true } },
        handlers(rootEl, redraw),
      );
      return;
    }
    render(rootEl, { kind: 'error', message: friendlyMessage(error), retryable: true });
  }
}

function friendlyMessage(error: unknown): string {
  if (error instanceof SidebarApiError) return error.message;
  return '网络或企微授权出现问题，请稍后重试。';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !root || !lastData) return;
  void refresh(root);
});
