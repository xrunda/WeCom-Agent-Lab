import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConsoleApp from '../src/App.tsx';
import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { MOCK_PASSWORD, getTenant, login, resetMockState } from '../src/mock/api.ts';
import {
  listOnboardingRequests,
  resetOnboardingState,
} from '../src/mock/onboarding.ts';
import { resetSettingsState } from '../src/mock/settings.ts';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

async function renderAt(path: string, username = 'admin') {
  await login(username, MOCK_PASSWORD);
  return render(
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <ConsoleApp />
          </AuthProvider>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  );
}

beforeEach(() => {
  resetMockState();
  resetSettingsState();
  resetOnboardingState();
});

describe('WP-M 价值看板', () => {
  it('价值条拆分三类采纳，并展示开通引导', async () => {
    await renderAt('/dashboard');

    const breakdown = await screen.findByLabelText('采纳率构成');
    expect(within(breakdown).getByText('原样采纳', { exact: false })).toBeInTheDocument();
    expect(within(breakdown).getByText('改稿后采纳', { exact: false })).toBeInTheDocument();
    expect(within(breakdown).getByText('人工改写', { exact: false })).toBeInTheDocument();
    expect(within(breakdown).getByText('已发出', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('草稿采纳率')).toBeInTheDocument();
    expect(screen.getByText('节省写作时间 · 估算')).toBeInTheDocument();
    expect(screen.getByText(/查看开通条件/)).toBeInTheDocument();
  });

  it('管理员修改撰写时长后节省时长口径生效', async () => {
    await renderAt('/dashboard');

    fireEvent.click(await screen.findByRole('button', { name: '修改节省时长口径' }));
    const input = await screen.findByRole('spinbutton');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(async () => {
      expect((await getTenant()).settings.writeMinutesPerDraft).toBe(5);
    });
    expect(
      await screen.findByText('口径已更新：每条草稿按 5 分钟估算'),
    ).toBeInTheDocument();
  });

  it('只读账号看不到口径设置入口', async () => {
    await renderAt('/dashboard', 'viewer');

    expect(await screen.findByText('节省写作时间 · 估算')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '修改节省时长口径' }),
    ).not.toBeInTheDocument();
  });
});

describe('WP-M 开通正式服务', () => {
  it('展示六项前置条件、时间线与席位成本', async () => {
    await renderAt('/settings/onboarding');

    expect(await screen.findByText('前置条件清单')).toBeInTheDocument();
    expect(screen.getByText('购买会话存档席位（按顾问人数）')).toBeInTheDocument();
    expect(screen.getByText('整体时间线')).toBeInTheDocument();
    expect(screen.getByText('席位成本计算器')).toBeInTheDocument();
    expect(screen.getByText('¥4,500')).toBeInTheDocument();
  });

  it('调整顾问人数后存档年费同步变化', async () => {
    await renderAt('/settings/onboarding');

    expect(await screen.findByText('¥4,500')).toBeInTheDocument();
    const [advisorsInput] = screen.getAllByRole('spinbutton');
    fireEvent.change(advisorsInput, { target: { value: '10' } });

    expect(await screen.findByText('¥9,000')).toBeInTheDocument();
    expect(screen.getByText('按 10 人计')).toBeInTheDocument();
  });

  it('管理员填写表单后可提交开通申请', async () => {
    await renderAt('/settings/onboarding');

    fireEvent.change(await screen.findByPlaceholderText('如：赵经理'), {
      target: { value: '赵经理' },
    });
    fireEvent.change(screen.getByPlaceholderText('用于我方负责人联系'), {
      target: { value: '13800000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /提交申请/ }));

    expect(await screen.findByText('申请已提交')).toBeInTheDocument();
    const { items } = await listOnboardingRequests();
    expect(items).toHaveLength(1);
    expect(items[0].contactName).toBe('赵经理');
    expect(items[0].expectedAdvisors).toBe(5);
  });

  it('只读账号可浏览但不能提交申请', async () => {
    await renderAt('/settings/onboarding', 'viewer');

    expect(
      await screen.findByText('只读账号可浏览，提交需主管或管理员'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /提交申请/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /保\s*存/ })).not.toBeInTheDocument();
  });
});
