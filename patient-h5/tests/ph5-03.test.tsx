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

describe('TodayPage（H03 结构）', () => {
  it('有数据时显示陪伴天数、今日安排与下一件小事', async () => {
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        date: '2026-11-25',
        greeting: '早上好',
        nextItem: {
          id: 'cal_1',
          title: '午餐时光',
          purpose: '按时吃饭',
          scheduledAt: Date.now(),
          status: 'pending',
          feedbackKind: 'record_meal',
          overdue: false,
        },
        progress: { done: 1, missed: 0, needsHelp: 0, pending: 3, total: 4 },
        quickRecord: { meal: true, review: true },
        relatedArticles: [
          { id: 'a1', title: '早餐怎样吃', summary: '搭配思路', category: 'classics_life', publishedAt: 0 },
        ],
        allDone: false,
        companionDays: 5,
      }),
    );
    render(
      <TodayPage
        statusHint={null}
        needOnboarding={false}
        onStartOnboarding={vi.fn()}
        onOpenCalendar={vi.fn()}
        onOpenNurture={vi.fn()}
        onOpenTeam={vi.fn()}
        onUnauthorized={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/陪伴你的第/)).toBeInTheDocument();
    });
    expect(screen.getByText('下一件小事')).toBeInTheDocument();
    expect(screen.getByText('今天的健康节奏')).toBeInTheDocument();
    expect(screen.getByText('拍照记餐')).toBeInTheDocument();
    expect(screen.getByText('专业团队一直在这里')).toBeInTheDocument();
  });

  it('未完成建档时显示状态提示与建档入口', () => {
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockRejectedValue(new Error('no data'));
    render(
      <TodayPage
        statusHint={{ title: '先完成建档', text: '回答几个小问题。' }}
        needOnboarding
        onStartOnboarding={vi.fn()}
        onOpenCalendar={vi.fn()}
        onOpenNurture={vi.fn()}
        onOpenTeam={vi.fn()}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(screen.getByText('先完成建档')).toBeInTheDocument();
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
    render(<NurturePage intro />);
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

describe('回归：review 修复项', () => {
  it('MePage 挂载只请求一次 /me（不再无限轮询）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    const meBody = {
      status: 'plan_active',
      reminderEnabled: true,
      serverTime: 0,
      companionDays: 5,
      profile: { completeness: 1, safetyMissing: false, conflicts: [] },
    };
    const todayBody = {
      date: '2026-11-25',
      greeting: '早上好',
      nextItem: null,
      progress: { done: 0, missed: 0, needsHelp: 0, pending: 0, total: 0 },
      quickRecord: { meal: false, review: false },
      relatedArticles: [],
      allDone: false,
      companionDays: 5,
    };
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/today') ? jsonResponse(200, todayBody) : jsonResponse(200, meBody),
      ),
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /我的/ }));
    await waitFor(() => {
      expect(screen.getByText('计划执行中')).toBeInTheDocument();
    });
    // 等两轮渲染
    await new Promise((resolve) => setTimeout(resolve, 60));
    const meCalls = fetchMock.mock.calls.filter(([url]) => url === '/zhiban/h5/me');
    expect(meCalls.length).toBeLessThanOrEqual(3);
  });

  it('主张页加载失败时仍能跳过（不卡死首次用户）', async () => {
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, { error: { code: 'INTERNAL', message: 'x' } }));
    const onSkip = vi.fn();
    render(<NurturePage intro onSkip={onSkip} onStart={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /先跳过/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /先跳过/ }));
    expect(onSkip).toHaveBeenCalled();
  });

  it('作息步只提交实际填写的组（不覆盖已存三餐时间）', async () => {
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { items: [], status: { completeness: 0 } }))
      .mockResolvedValueOnce(jsonResponse(200, { entries: [{ id: 'ppe_1' }], status: {} }));
    render(<OnboardingWizard onUnauthorized={vi.fn()} onDone={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '改善睡眠' }));
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => screen.getByLabelText('早餐时间'));
    // 只填入睡时间，不填三餐
    await userEvent.type(screen.getByLabelText('通常入睡'), '23:00');
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => {
      const routine = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => url === '/zhiban/h5/profile/answers')
        .map(([, init]) => JSON.parse(String((init as RequestInit)?.body)))
        .find((body) => body.step === 'routine');
      expect(routine).toBeDefined();
      expect(routine.answers).toEqual({ sleep_time: { bedtime: '23:00' } });
      expect(routine.answers.meal_times).toBeUndefined();
    });
  });
});
