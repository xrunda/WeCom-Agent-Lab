/**
 * PH5-03（#232）前端测试：四导航骨架、食养主张、分步建档、状态覆盖。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.tsx';
import { NurturePage } from '../src/pages/NurturePage.tsx';
import { OnboardingWizard } from '../src/pages/OnboardingWizard.tsx';
import { TodayPage } from '../src/pages/TodayPage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('TodayPage（占位骨架）', () => {
  it('无计划时显示准备中与建档入口', () => {
    render(
      <TodayPage
        me={{ status: 'plan_generating', reminderEnabled: false, serverTime: 0 }}
        onStartOnboarding={() => undefined}
        onOpenNurture={() => undefined}
      />,
    );
    expect(screen.getByText('正在为你准备计划')).toBeInTheDocument();
    expect(screen.getByText('今日进度')).toBeInTheDocument();
    expect(screen.getByText('快捷记录')).toBeInTheDocument();
    expect(screen.getByText('相关食养')).toBeInTheDocument();
    expect(screen.getByText('你的团队')).toBeInTheDocument();
  });

  it('资料未完善时主行动是建档（刷新/返回不串状态的验收基础）', () => {
    render(
      <TodayPage
        me={{ status: 'profile_incomplete', reminderEnabled: false, serverTime: 0 }}
        onStartOnboarding={() => undefined}
        onOpenNurture={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '开始建档' })).toBeInTheDocument();
  });
});

describe('NurturePage（H01 食养主张）', () => {
  it('经典/白话/品牌文案区分展示，出处可核对', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        version: 1,
        slogans: ['饮食有养', '起居有常', '健康有伴'],
        sections: [
          { kind: 'classic_quote', text: '五谷为养，五果为助', citation: '《黄帝内经·素问》' },
          { kind: 'plain_explanation', text: '主食养身、果菜相助。' },
          { kind: 'brand_copy', text: '食养融入日常。' },
        ],
      }),
    );
    render(<NurturePage />);
    await waitFor(() => {
      expect(screen.getByText('五谷为养，五果为助')).toBeInTheDocument();
    });
    expect(screen.getByText('出处：《黄帝内经·素问》')).toBeInTheDocument();
    expect(screen.getByText('经典原文')).toBeInTheDocument();
    expect(screen.getByText('白话解释')).toBeInTheDocument();
    expect(screen.getByText('服务主张')).toBeInTheDocument();
  });

  it('intro 模式提供开始与跳过（跳过不算完成建档）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { version: 1, slogans: [], sections: [{ kind: 'brand_copy', text: 'x' }] }),
    );
    const onSkip = vi.fn();
    render(<NurturePage intro onSkip={onSkip} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /先跳过/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /先跳过/ }));
    expect(onSkip).toHaveBeenCalled();
  });
});

describe('OnboardingWizard（H02 分步建档）', () => {
  it('第一步选目标后可进入下一步；提交带 step 与答案', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], status: {} }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { entries: [{ id: 'ppe_1' }], status: { completeness: 0.2 } }),
    );
    render(<OnboardingWizard onUnauthorized={() => undefined} onDone={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '改善睡眠' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: '改善睡眠' }));
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/zhiban/h5/profile/answers',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ step: 'basics', answers: { goal: { items: ['改善睡眠'] } } }),
        }),
      );
    });
    // 第二步出现
    expect(screen.getByText('通常的作息')).toBeInTheDocument();
  });

  it('过敏步允许「不清楚」，提交 unknown=true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], status: {} }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { entries: [], status: {} }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { entries: [], status: {} }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { entries: [], status: {} }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { entries: [], status: {} }));
    render(<OnboardingWizard onUnauthorized={() => undefined} onDone={() => undefined} />);
    // 快进到第 4 步（safety）
    await userEvent.click((await screen.findByRole('button', { name: '改善睡眠' })));
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => screen.getByLabelText('早餐时间'));
    await userEvent.type(screen.getByLabelText('早餐时间'), '07:30');
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => screen.getByRole('button', { name: '清淡' }));
    await userEvent.click(screen.getByRole('button', { name: '清淡' }));
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => screen.getByText('过敏与禁忌'), { timeout: 3000 });
    await userEvent.click(screen.getByRole('switch', { name: /不清楚自己有没有过敏/ }));
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/zhiban/h5/profile/answers',
        expect.objectContaining({
          body: JSON.stringify({
            step: 'safety',
            answers: { allergy: { unknown: true, items: [] } },
          }),
        }),
      );
    });
  });
});

describe('App 状态覆盖（未登录/已登录建档）', () => {
  it('未登录进入登录页', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('401'), { status: 401 }),
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
    });
  });
});
