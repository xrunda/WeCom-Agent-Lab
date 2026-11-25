/**
 * 演示模式（VITE_API_MODE=demo）端到端：不发任何网络请求，
 * 直接用虚构数据渲染今天页与日历页。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  vi.stubEnv('VITE_API_MODE', 'demo');
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('演示模式不应发请求'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('演示模式', () => {
  it('直接进入主应用，显示演示数据横幅与今天页内容', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('演示数据 · 非真实患者信息')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/陪伴你的第/)).toBeInTheDocument();
    });
    expect(screen.getByText('下一件小事')).toBeInTheDocument();
    expect(screen.getByText('今天的健康节奏')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('日历页显示今日进度与食养提示', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('navigation', { name: '主导航' }));
    await userEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: /日历/ }));
    await waitFor(() => {
      expect(screen.getByText('我的健康日历')).toBeInTheDocument();
    });
    expect(screen.getByText(/今日安排 1 \/ 4 已完成/)).toBeInTheDocument();
    expect(screen.getByText('饮食有节，贵在日常')).toBeInTheDocument();
  });

  it('食养页显示分类、精选文章与列表，且不出搜索框（增强项）', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('navigation', { name: '主导航' }));
    await userEvent.click(
      within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: /食养/ }),
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '食养' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '为你推荐' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认识食材' })).toBeInTheDocument();
    expect(screen.getByText('与你的计划有关')).toBeInTheDocument();
    // 搜索是增强项，未实现不得出现
    expect(screen.queryByPlaceholderText(/搜索/)).not.toBeInTheDocument();
  });

  it('我的页显示陪伴天数与统计，且不出现「阶段回顾」（增强项）', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('navigation', { name: '主导航' }));
    await userEvent.click(
      within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: /我的/ }),
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '我的健康生活' })).toBeInTheDocument();
    });
    expect(screen.getByText(/与知伴相伴的第/)).toBeInTheDocument();
    expect(screen.getByText('已记录餐食')).toBeInTheDocument();
    expect(screen.getByText('已完成回顾')).toBeInTheDocument();
    expect(screen.queryByText('阶段回顾')).not.toBeInTheDocument();
    expect(screen.getByText('隐私与授权')).toBeInTheDocument();
  });

  it('我的 → 查看计划 打开计划页，展示审核人与版本，且无固定 28 天', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('navigation', { name: '主导航' }));
    await userEvent.click(
      within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: /我的/ }),
    );
    await waitFor(() => screen.getByText('我的健康计划'));
    await userEvent.click(screen.getByRole('button', { name: /查看计划/ }));
    await waitFor(() => {
      expect(screen.getByText('专业团队已审核')).toBeInTheDocument();
    });
    expect(screen.getByText(/第 2 版/)).toBeInTheDocument();
    expect(screen.queryByText(/28\s*天/)).not.toBeInTheDocument();
  });
});
