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
import { escapeHtml, formatWait, render } from '../src/sidebar/view.ts';
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
    expect(root.textContent).toContain('本群没有未回复的消息');
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

  it('错误状态可重试', () => {
    const root = document.createElement('div');
    const retry = vi.fn();
    render(root, { kind: 'error', message: '网络不可用', retryable: true }, retry);
    (root.querySelector('[data-retry]') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('401 由上层跳授权，不用展示成普通错误', () => {
    expect(new SidebarApiError(401, 'UNAUTHENTICATED', 'x').status).toBe(401);
  });
});
