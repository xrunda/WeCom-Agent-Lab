/**
 * PH5-04 患者计划页：只读已发布版本，展示审核人与版本，不出现固定 28 天。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlanPage } from '../src/pages/PlanPage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const plan = {
  id: 'hpl_1',
  version: 2,
  status: 'published',
  stageGoal: '把三餐吃规律',
  startDate: '2026-12-01',
  endDate: '2026-12-21',
  foodTherapyRationale: '先从规律三餐开始',
  focusPoints: ['饮食更规律', '作息更稳定'],
  rationale: { basedOn: ['你的目标：改善睡眠'] },
  actions: [
    {
      actionId: 'act_1',
      title: '早餐记录',
      purpose: '看看早餐够不够丰富',
      method: '拍照或文字记录',
      schedule: { kind: 'daily', time: '07:30' },
      feedbackKind: 'record_meal',
      linkedArticleIds: [],
    },
  ],
  feedbackRequirements: [],
  review: { reviewerName: '陈营养师（虚构）', reviewedAt: Date.now() },
  publishedAt: Date.now(),
  acknowledgedAt: null,
};

describe('PlanPage（H04）', () => {
  it('展示审核人、版本与阶段重点，不出现固定 28 天', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { plan }));
    render(<PlanPage onBack={vi.fn()} onAdjust={vi.fn()} onOpenCalendar={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('专业团队已审核')).toBeInTheDocument();
    });
    expect(screen.getByText(/第 2 版/)).toBeInTheDocument();
    expect(screen.getByText('早餐记录')).toBeInTheDocument();
    expect(screen.getByText(/审核：陈营养师（虚构）/)).toBeInTheDocument();
    expect(screen.queryByText(/28\s*天/)).not.toBeInTheDocument();
  });

  it('没有已发布方案时显示错误提示而不是空白页', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: '暂无已发布方案' } }),
    );
    render(<PlanPage onBack={vi.fn()} onAdjust={vi.fn()} onOpenCalendar={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('暂无已发布方案');
    });
  });
});
