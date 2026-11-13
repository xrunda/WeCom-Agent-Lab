/**
 * #145 侧边栏前端：会话解析、转义与首屏状态。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  configureAgent,
  contextQuery,
  resolveConversation,
} from '../src/sidebar/wecom.ts';
import type { WxLike } from '../src/sidebar/wecom.ts';
import { escapeHtml, formatWait, relativeLabel, render, waitTier } from '../src/sidebar/view.ts';
import type { SidebarContextData } from '../src/sidebar/types.ts';
import { SidebarApiError } from '../src/sidebar/api.ts';

function wxWith(results: Record<string, { err_msg?: string; chatId?: string; userId?: string }>): WxLike {
  return {
    agentConfig: () => {},
    invoke: (name, _args, callback) => callback(results[name] ?? { err_msg: `${name}:fail` }),
  };
}

const data: SidebarContextData = {
  conv: { kind: 'group', key: 'room:room_1', name: '高血压管理 1 群', served: true, lastObservedAt: 1 },
  pending: { open: [], recentlyClosed: [], openCount: 0, oldestWaitSeconds: null },
  profile: {
    bound: true,
    name: '王阿姨',
    confirmed: true,
    tags: ['高血压'],
    chronic: null,
    carePlan: null,
    silentDays: 3,
    advisorName: '李医生',
  },
  generatedAt: 1,
};

describe('会话解析', () => {
  it('外部群取 chatId', async () => {
    const ref = await resolveConversation(
      wxWith({ getCurExternalChat: { err_msg: 'getCurExternalChat:ok', chatId: 'chat_1' } }),
    );
    expect(ref).toEqual({ kind: 'group', chatId: 'chat_1' });
    expect(contextQuery(ref)).toBe('chatId=chat_1');
  });

  it('单聊取 externalUserId', async () => {
    const ref = await resolveConversation(
      wxWith({ getCurExternalContact: { err_msg: 'getCurExternalContact:ok', userId: 'wm_a' } }),
    );
    expect(ref).toEqual({ kind: 'dm', externalUserId: 'wm_a' });
    expect(contextQuery(ref)).toBe('externalUserId=wm_a');
  });

  it('内部群或非企微环境返回 unsupported', async () => {
    const ref = await resolveConversation(wxWith({}));
    expect(ref).toEqual({ kind: 'unsupported' });
    expect(contextQuery(ref)).toBe('');
  });

  it('agentConfig 失败会拒绝，不继续调 invoke', async () => {
    const invoke = vi.fn();
    const wx: WxLike = {
      agentConfig: ({ fail }) => (fail as () => void)(),
      invoke,
    };
    await expect(
      configureAgent(wx, {
        corpId: 'c',
        agentId: '1',
        timestamp: '1',
        nonceStr: 'n',
        signature: 's',
        jsApiList: [],
      }),
    ).rejects.toThrow('JS-SDK');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('首屏渲染', () => {
  it('动态文本一律转义', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
    const root = document.createElement('div');
    render(root, {
      kind: 'ready',
      data: {
        ...data,
        conv: { ...data.conv, name: '<script>alert(1)</script>' },
      },
    });
    expect(root.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(root.innerHTML).toContain('&lt;script&gt;');
  });

  it('有群名、待回复数与客户名', () => {
    const root = document.createElement('div');
    render(root, { kind: 'ready', data });
    expect(root.textContent).toContain('高血压管理 1 群');
    expect(root.textContent).toContain('本会话没有待回复');
    expect(root.textContent).toContain('王阿姨');
    expect(root.textContent).toContain('高血压');
  });

  it('未接入会话显示可读兜底，不空白', () => {
    const root = document.createElement('div');
    render(root, { kind: 'unsupported', reason: 'DM_NOT_SUPPORTED' });
    expect(root.textContent).toContain('客户单聊暂未接入');
  });

  it('等待时长按分钟/小时/天分档', () => {
    expect(formatWait(30)).toBe('刚刚');
    expect(formatWait(90)).toBe('1 分钟');
    expect(formatWait(7200)).toBe('2 小时');
    expect(formatWait(3 * 86_400)).toBe('3 天');
  });

  it('错误状态可重试；不可重试时不放按钮', () => {
    const root = document.createElement('div');
    const retry = vi.fn();
    render(root, { kind: 'error', message: '网络不可用', retryable: true }, { onRetry: retry });
    (root.querySelector('[data-retry]') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledTimes(1);

    render(root, { kind: 'error', message: '没有权限', retryable: false });
    expect(root.querySelector('[data-retry]')).toBeNull();
  });

  it('登录失效显示整页说明', () => {
    const root = document.createElement('div');
    render(root, { kind: 'auth-expired' });
    expect(root.textContent).toContain('登录已失效');
  });

  it('401 由上层跳授权，不用展示成普通错误', () => {
    expect(new SidebarApiError(401, 'UNAUTHENTICATED', 'x').status).toBe(401);
  });
});


describe('待回复卡片（#148）', () => {
  const pendingData: SidebarContextData = {
    ...data,
    pending: {
      open: [
        {
          id: 'p1',
          customerId: 'wm_a',
          customerName: '王阿姨',
          firstAt: 1_700_000_000_000,
          lastAt: 1_700_000_000_000,
          messageCount: 2,
          excerpt: '早上吃完药有点头晕，要不要停？',
          waitSeconds: 7_500,
          reason: 'question',
          aiReplied: false,
          hasDraft: false,
        },
        {
          id: 'p2',
          customerId: 'wm_b',
          customerName: null,
          firstAt: 1_700_000_100_000,
          lastAt: 1_700_000_100_000,
          messageCount: 1,
          excerpt: '明天的复诊是几点？',
          waitSeconds: 600,
          reason: 'question',
          aiReplied: true,
          hasDraft: false,
        },
      ],
      recentlyClosed: [{ id: 'p0', closedAt: 1_700_000_000_000, closedBy: null }],
      openCount: 2,
      oldestWaitSeconds: 7_500,
    },
  };

  it('等待时长分档：30 分钟、2 小时', () => {
    expect(waitTier(60)).toBe('calm');
    expect(waitTier(30 * 60)).toBe('warn');
    expect(waitTier(2 * 60 * 60)).toBe('urgent');
  });

  it('条目按等得最久排序，带档位、原文与操作', () => {
    const root = document.createElement('div');
    render(root, { kind: 'ready', data: pendingData });
    const items = root.querySelectorAll('.item');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('王阿姨');
    expect(items[0]!.textContent).toContain('等了 2 小时 05 分');
    expect(items[0]!.querySelector('.wait-urgent')).not.toBeNull();
    expect(items[0]!.querySelector('[data-copy]')!.getAttribute('data-copy')).toBe(
      '早上吃完药有点头晕，要不要停？',
    );
    expect(items[1]!.textContent).toContain('客户');
    expect(items[1]!.textContent).toContain('机器人已回应');
    expect((items[1]!.querySelectorAll('.op')[1] as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain('已回复 1 条');
  });

  it('复制成功按钮短暂变为已复制', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const root = document.createElement('div');
    render(root, { kind: 'ready', data: pendingData });
    const button = root.querySelector('[data-copy]') as HTMLButtonElement;
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('早上吃完药有点头晕，要不要停？');
    expect(button.textContent).toBe('已复制');
    vi.advanceTimersByTime(2_000);
    expect(button.textContent).toBe('复制原话');
    vi.useRealTimers();
  });

  it('刷新入口可点，刷新失败提示保留上次内容', () => {
    const root = document.createElement('div');
    const refresh = vi.fn();
    render(root, { kind: 'ready', data: pendingData }, { onRefresh: refresh });
    (root.querySelector('[data-refresh]') as HTMLButtonElement).click();
    expect(refresh).toHaveBeenCalledTimes(1);

    render(root, {
      kind: 'ready',
      data: pendingData,
      notice: { message: '刷新失败，正在显示上次的内容', retryable: true },
    }, { onRefresh: refresh });
    expect(root.textContent).toContain('刷新失败');
  });

  it('空态显示最后同步时间', () => {
    const root = document.createElement('div');
    render(root, { kind: 'ready', data });
    expect(root.textContent).toContain('本会话没有待回复');
    expect(root.textContent).toContain('更新于');
  });

  it('同步时间按分钟/小时/天分档', () => {
    expect(relativeLabel(30)).toBe('刚刚');
    expect(relativeLabel(5 * 60)).toBe('5 分钟前');
    expect(relativeLabel(3 * 3600)).toBe('3 小时前');
    expect(relativeLabel(2 * 86_400)).toBe('2 天前');
  });

  it('控制台入口只在配置了地址时出现', () => {
    const root = document.createElement('div');
    render(root, { kind: 'ready', data }, { consoleUrl: 'https://console.example.com/' });
    expect(root.textContent).toContain('打开控制台详情');

    render(root, { kind: 'ready', data });
    expect(root.textContent).not.toContain('打开控制台详情');
  });
});
