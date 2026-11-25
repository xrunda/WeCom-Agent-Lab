/**
 * PH5-05 日历反馈交互：打开详情、三种反馈、未来事项不可提前确认。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarPage } from '../src/pages/CalendarPage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cal_1',
    title: '午餐时光',
    purpose: '按时吃饭',
    method: '到点吃饭，吃完记一句',
    scheduledAt: Date.now(),
    scheduledDate: todayStr,
    status: 'pending',
    feedbackKind: 'record_meal',
    overdue: false,
    cancelReason: null,
    canFeedback: true,
    ...overrides,
  };
}

function calendarBody(items: unknown[]) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - ((today.getDay() + 6) % 7) + index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { date: key, items: key === todayStr ? items : [] };
  });
  return { days, from: days[0].date, to: days[6].date, dailyTip: null };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CalendarPage 反馈', () => {
  it('点事项打开详情，确认完成后状态更新', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, calendarBody([item()])));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, item({ status: 'done', canFeedback: false })),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, calendarBody([item({ status: 'done', canFeedback: false })])),
    );

    render(<CalendarPage onUnauthorized={vi.fn()} onBackToNurture={vi.fn()} />);
    await waitFor(() => screen.getByText('午餐时光'));
    await userEvent.click(screen.getByText('午餐时光'));

    await waitFor(() => expect(screen.getByRole('dialog', { name: '事项详情' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '我完成了' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/zhiban/h5/calendar/items/cal_1/feedback',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        kind: 'patient_confirmed',
      });
    });
  });

  it('「需要帮助」提示已转交团队', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, calendarBody([item()])));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, item({ status: 'needs_help', canFeedback: false })),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, calendarBody([item({ status: 'needs_help', canFeedback: false })])),
    );

    render(<CalendarPage onUnauthorized={vi.fn()} onBackToNurture={vi.fn()} />);
    await waitFor(() => screen.getByText('午餐时光'));
    await userEvent.click(screen.getByText('午餐时光'));
    await userEvent.click(await screen.findByRole('button', { name: '需要帮助' }));

    await waitFor(() => {
      expect(screen.getByText(/已告诉团队/)).toBeInTheDocument();
    });
  });

  it('未来事项不给反馈按钮（不能提前完成）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, calendarBody([item({ canFeedback: false, scheduledDate: '2099-01-01' })])),
    );
    render(<CalendarPage onUnauthorized={vi.fn()} onBackToNurture={vi.fn()} />);
    await waitFor(() => screen.getByText('午餐时光'));
    await userEvent.click(screen.getByText('午餐时光'));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '我完成了' })).not.toBeInTheDocument();
    expect(screen.getByText(/还没到这一天/)).toBeInTheDocument();
  });
});
