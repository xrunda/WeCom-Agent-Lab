/**
 * 侧边栏入口（#145 / #148）。
 *
 * 顺序固定：先出骨架 → JS-SDK 鉴权 → 取当前会话 → 取首屏数据。
 * 401 只静默重试一次，其次显示「登录已失效」，避免和企微授权来回跳。
 * 轮询 30 秒，页面隐藏时暂停，切回立即刷新。
 */
import './sidebar.css';
import { AUTH_START_PATH, SidebarApiError, fetchAgentConfig, fetchContext, postClose, postEvent } from './api.ts';
import { render } from './view.ts';
import type { ViewHandlers } from './view.ts';
import { WxConfigError, configureAgent, contextQuery, resolveConversation } from './wecom.ts';
import type { ConversationRef, WxLike } from './wecom.ts';
import type { SidebarState } from './types.ts';

declare global {
  interface Window {
    wx?: WxLike;
  }
}

const POLL_MS = 30_000;
/**
 * 企微客户端不保证预置可用的 wx：注入的对象可能没有 agentConfig。
 * index.html 已静态引入官方 SDK；仍拿不到时按顺序兜底注入。
 * 顺序不能反：jweixin 先定义 window.wx，jwxwork 再往上挂 agentConfig。
 */
const WX_SDK_URLS = [
  'https://res.wx.qq.com/open/js/jweixin-1.2.0.js',
  'https://open.work.weixin.qq.com/wwopen/js/jwxwork-1.0.0.js',
];
/** 静态 <script defer> 通常 1 秒内就绪，留一点首屏余量 */
const WX_SDK_WAIT_MS = 2_500;
const WX_SDK_TIMEOUT_MS = 6_000;
const AUTH_TRIED_KEY = 'zb_sidebar_auth_tried';
const CONSOLE_URL: string | undefined = import.meta.env.VITE_CONSOLE_URL;

const root = document.getElementById('root');

/** 注入的 wx 未必带 agentConfig，只认带了的那一份 */
function sdkReady(): boolean {
  return typeof window.wx?.agentConfig === 'function';
}

function injectScript(src: string): Promise<'load' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | undefined;
    const finish = (status: 'load' | 'error' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      script.remove();
      resolve(status);
    };
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => finish('load');
    script.onerror = () => finish('error');
    timer = window.setTimeout(() => finish('timeout'), WX_SDK_TIMEOUT_MS);
    document.head.appendChild(script);
  });
}

/** 等静态引入的 SDK 就绪；到点没等到就走兜底注入 */
function waitForSdk(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (sdkReady() || Date.now() >= deadline) {
        resolve();
        return;
      }
      window.setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * 现场排查用：把 SDK 加载结果打到访问日志（query 里只有状态位，没有凭据与会话）。
 * 手机端看不到控制台，这是唯一能拿到真机信息的方式。
 */
function reportSdkDiag(detail: string): void {
  try {
    void fetch(`/zhiban/sidebar/health?dx=${encodeURIComponent(detail)}`, {
      cache: 'no-store',
      credentials: 'omit',
    }).catch(() => undefined);
  } catch {
    // 诊断失败不影响主流程
  }
}

/** 拿到可用的 wx：客户端注入的能用就用，否则用静态引入 / 兜底注入的官方 SDK */
async function loadWxSdk(): Promise<WxLike | undefined> {
  const marks = [
    `wx=${window.wx ? 1 : 0}`,
    `ag=${sdkReady() ? 1 : 0}`,
    `sb=${'WeixinSandBox' in window ? 1 : 0}`,
  ];
  if (!sdkReady()) {
    await waitForSdk(WX_SDK_WAIT_MS);
    marks.push(`wait=${sdkReady() ? 1 : 0}`);
  }
  if (!sdkReady()) {
    const results: string[] = [];
    for (const url of WX_SDK_URLS) {
      results.push(await injectScript(url));
      if (sdkReady()) break;
    }
    marks.push(`inject=${results.join('/')}`, `ag2=${sdkReady() ? 1 : 0}`);
  }
  reportSdkDiag(marks.join(','));
  return window.wx;
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
  reportedOpen = false;
  reportedPendingView = false;
  render(rootEl, { kind: 'loading' });

  const wx = await loadWxSdk();
  if (!wx || typeof wx.agentConfig !== 'function') {
    render(
      rootEl,
      {
        kind: 'error',
        message: '企微客户端没有提供可用的 JS-SDK（缺少 agentConfig），请升级企业微信后重试。',
        retryable: true,
      },
      handlers(rootEl, () => void start(rootEl)),
    );
    return;
  }

  try {
    // 只给去掉 hash 的页面地址签名；服务端会拒绝其它来源
    const pageUrl = location.href.split('#')[0] ?? location.href;
    const config = await fetchAgentConfig(pageUrl);
    await configureAgent(wx, config);

    conversation = await resolveConversation(wx);
    if (conversation.kind === 'unsupported') {
      render(
        rootEl,
        { kind: 'unsupported', reason: 'NO_CONVERSATION' },
        handlers(rootEl, () => void start(rootEl)),
      );
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
    if (error instanceof WxConfigError) {
      // 现场只有这块屏幕，把企微的 errMsg 也带进访问日志
      reportSdkDiag(`ac=${error.message.slice(0, 120)}`);
    }
    render(
      rootEl,
      { kind: 'error', message: friendlyMessage(error), retryable: true },
      handlers(rootEl, () => void refresh(rootEl)),
    );
  }
}

let lastData: SidebarState & { kind: 'ready' } | undefined;
/** 每次打开侧边栏只上报一次，避免 30 秒轮询把统计刷成噪声 */
let reportedOpen = false;
let reportedPendingView = false;

async function closeItem(
  rootEl: HTMLElement,
  id: string,
  reason: 'handled' | 'dismissed' | 'transferred',
): Promise<void> {
  try {
    await postClose(id, reason);
    await refresh(rootEl);
  } catch (error) {
    if (error instanceof SidebarApiError && error.status === 401) {
      handleAuthFailure();
      return;
    }
    if (lastData) {
      render(
        rootEl,
        { ...lastData, notice: { message: '操作没成功，请重试', retryable: true } },
        handlers(rootEl, () => void refresh(rootEl)),
      );
    }
  }
}

function handlers(rootEl: HTMLElement, redraw: () => void): ViewHandlers {
  return {
    onRefresh: redraw,
    onRetry: () => void start(rootEl),
    onClose: (id, reason) => void closeItem(rootEl, id, reason),
    onEvent: (event, itemId) => void postEvent(event, itemId),
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
      render(
        rootEl,
        {
          kind: 'unsupported',
          reason:
            data.conv.reason ??
            (conversation.kind === 'dm' ? 'DM_NOT_SUPPORTED' : 'GROUP_NOT_FOUND'),
        },
        handlers(rootEl, redraw),
      );
      return;
    }
    writeAuthTried(false);
    lastData = { kind: 'ready', data };
    render(rootEl, lastData, handlers(rootEl, redraw));
    if (!reportedOpen) {
      reportedOpen = true;
      void postEvent('sidebar.open');
    }
    if (!reportedPendingView && data.pending.openCount > 0) {
      reportedPendingView = true;
      void postEvent('pending.view');
    }
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
    render(
      rootEl,
      { kind: 'error', message: friendlyMessage(error), retryable: true },
      handlers(rootEl, () => void refresh(rootEl)),
    );
  }
}

function friendlyMessage(error: unknown): string {
  if (error instanceof SidebarApiError) return error.message;
  // 企微 errMsg 只有接口名和原因，不含凭据；显示出来便于现场排查
  if (error instanceof WxConfigError) return error.message;
  return '网络或企微授权出现问题，请稍后重试。';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !root || !lastData) return;
  void refresh(root);
});

// 启动必须放在模块末尾：上面的 let 声明（reportedOpen / lastData 等）
// 在模块求值阶段尚未初始化，提前调用 start() 会撞上 TDZ，页面停在骨架不动。
if (root) {
  render(root, { kind: 'loading' });
  void start(root).catch(() => {
    render(
      root,
      { kind: 'error', message: '侧边栏没能启动，请关闭后重新打开。', retryable: true },
      handlers(root, () => void start(root)),
    );
  });
}
