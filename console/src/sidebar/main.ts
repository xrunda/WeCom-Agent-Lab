/**
 * 侧边栏入口（#145）。
 *
 * 顺序固定：先出骨架 → JS-SDK 鉴权 → 取当前会话 → 取首屏数据。
 * 401 只有一种处理：跳企微静默授权；不在前端硬编码任何凭据。
 */
import './sidebar.css';
import { AUTH_START_PATH, SidebarApiError, fetchAgentConfig, fetchContext } from './api.ts';
import { render } from './view.ts';
import { configureAgent, contextQuery, resolveConversation } from './wecom.ts';
import type { WxLike } from './wecom.ts';

declare global {
  interface Window {
    wx?: WxLike;
  }
}

const root = document.getElementById('root');
if (root) {
  render(root, { kind: 'loading' });
  void start(root);
}

async function start(root: HTMLElement): Promise<void> {
  const retry = (): void => {
    render(root, { kind: 'loading' });
    void start(root);
  };

  const wx = window.wx;
  if (!wx) {
    render(root, {
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

    const conversation = await resolveConversation(wx);
    if (conversation.kind === 'unsupported') {
      render(root, { kind: 'unsupported', reason: 'NO_CONVERSATION' });
      return;
    }

    const data = await fetchContext(contextQuery(conversation));
    if (!data.conv.served) {
      render(root, {
        kind: 'unsupported',
        reason:
          data.conv.reason ??
          (conversation.kind === 'dm' ? 'DM_NOT_SUPPORTED' : 'GROUP_NOT_FOUND'),
      });
      return;
    }
    render(root, { kind: 'ready', data });
  } catch (error) {
    if (error instanceof SidebarApiError && error.status === 401) {
      // 会话缺失或过期：走一次企微静默授权，回来后重新取数
      location.replace(AUTH_START_PATH);
      return;
    }
    if (error instanceof SidebarApiError && error.status === 403) {
      render(root, {
        kind: 'error',
        message: '你不是这个会话的负责顾问，暂时看不到这里的数据。',
        retryable: false,
      });
      return;
    }
    render(root, {
      kind: 'error',
      message: '网络或企微授权出现问题，请稍后重试。',
      retryable: true,
    }, retry);
  }
}
