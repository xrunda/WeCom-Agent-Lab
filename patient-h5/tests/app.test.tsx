/**
 * PH5-02 患者入口页测试：
 * - 邀请码从 URL 读取后立即清理（A01：兑换前 URL 就不保留敏感参数）
 * - 授权页渲染五项分项授权并调用 decideConsent
 * - 登录页错误文案分类（过期邀请 → 联系顾问）
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from '../src/api.ts';
import { extractInviteCode } from '../src/App.tsx';
import { ConsentsPage } from '../src/pages/ConsentsPage.tsx';
import { InviteLoginPage } from '../src/pages/InviteLoginPage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('extractInviteCode', () => {
  it('读取 ?code= 后立即从 URL 清除', () => {
    window.history.replaceState(null, '', '/h5/invite?code=secret_code_1&from=share');
    const code = extractInviteCode();
    expect(code).toBe('secret_code_1');
    expect(window.location.search).not.toContain('secret_code_1');
    expect(window.location.search).toContain('from=share');
    expect(extractInviteCode()).toBeNull();
  });

  it('无 code 时返回 null 且不动 URL', () => {
    window.history.replaceState(null, '', '/h5/invite');
    expect(extractInviteCode()).toBeNull();
  });
});

describe('ConsentsPage', () => {
  it('渲染五项分项授权，开关调用 decideConsent', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        textsVersion: 1,
        items: [
          { scope: 'service_basic', status: 'granted', version: 1, grantedAt: 1, withdrawnAt: null, title: '进入个人服务', summary: '查看你的计划' },
          { scope: 'health_processing', status: 'never', version: 1, grantedAt: null, withdrawnAt: null, title: 'AI 处理健康信息', summary: '生成计划' },
          { scope: 'photo_analysis', status: 'never', version: 1, grantedAt: null, withdrawnAt: null, title: '餐食照片识别', summary: '识别照片' },
          { scope: 'team_access', status: 'granted', version: 1, grantedAt: 1, withdrawnAt: null, title: '团队查看记录', summary: '跟进用' },
          { scope: 'reminder', status: 'withdrawn', version: 1, grantedAt: null, withdrawnAt: 1, title: '提醒触达', summary: '发提醒' },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { scope: 'health_processing', status: 'granted', version: 1 }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    const onUnauthorized = vi.fn();
    render(<ConsentsPage onUnauthorized={onUnauthorized} />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: '进入个人服务' })).toBeChecked();
    });
    expect(screen.getByRole('switch', { name: '提醒触达' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('switch', { name: 'AI 处理健康信息' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/zhiban/h5/consents/decide',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ scope: 'health_processing', action: 'grant' }),
        }),
      );
    });
    expect(screen.getByText(/已授权「AI 处理健康信息」/)).toBeInTheDocument();
  });
});

describe('InviteLoginPage', () => {
  it('邀请过期显示联系顾问的引导（错误分类）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(410, {
        error: { code: 'INVITATION_EXPIRED', message: '邀请已过期' },
      }),
    );
    render(<InviteLoginPage inviteCode="pinv_x" onDone={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('手机号'), '13800003421');
    await userEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    await waitFor(() => {
      expect(screen.getByText(/邀请已过期，请联系顾问重新发送/)).toBeInTheDocument();
    });
  });

  it('手机号不匹配给出核对提示', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: { code: 'PHONE_MISMATCH', message: '手机号不一致' },
      }),
    );
    render(<InviteLoginPage inviteCode="pinv_x" onDone={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('手机号'), '13800003421');
    await userEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    await waitFor(() => {
      expect(screen.getByText(/手机号与邀请预留的不一致/)).toBeInTheDocument();
    });
  });
});

describe('api 客户端', () => {
  it('401 抛出 ApiError 并携带 code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: '未登录' } }),
    );
    await expect(api.fetchMe()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });
});
