/**
 * PH5-06 记录面板：餐食保存、回顾可跳过、照片失败不影响已保存记录。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordSheet } from '../src/components/RecordSheet.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const record = {
  id: 'rec_1',
  kind: 'meal',
  occurredAt: Date.now(),
  occurredDate: '2026-11-25',
  submittedAt: Date.now(),
  content: {},
  mediaIds: [],
};

beforeEach(() => fetchMock.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RecordSheet', () => {
  it('餐食记录：填内容后提交，带幂等键与关联事项', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, record));
    const onSaved = vi.fn();
    render(
      <RecordSheet mode="meal" defaultMealType="lunch" linkedCalendarItemId="cal_1" onClose={vi.fn()} onSaved={onSaved} />,
    );
    await userEvent.type(screen.getByLabelText(/吃了什么/), '米饭、清蒸鱼');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('已记录这一餐'));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.kind).toBe('meal');
    expect(body.meal.mealType).toBe('lunch');
    expect(body.meal.confirmedFoods).toEqual([{ name: '米饭' }, { name: '清蒸鱼' }]);
    expect(body.linkedCalendarItemIds).toEqual(['cal_1']);
    expect(typeof body.idempotencyKey).toBe('string');
  });

  it('晚间回顾：可以不选任何项直接保存（不预选正常）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { ...record, kind: 'evening_review' }));
    const onSaved = vi.fn();
    render(<RecordSheet mode="review" defaultMealType="dinner" onClose={vi.fn()} onSaved={onSaved} />);

    // 没有任何项默认选中
    for (const button of screen.getAllByRole('button')) {
      if (['不错', '一般', '有点累', '不太舒服'].includes(button.textContent ?? '')) {
        expect(button).toHaveAttribute('aria-pressed', 'false');
      }
    }
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.review).toEqual({});
  });

  it('不适描述随回顾一起提交', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { ...record, kind: 'evening_review' }));
    render(<RecordSheet mode="review" defaultMealType="dinner" onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/有没有不舒服/), '晚饭后有点胀');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.review.discomfort).toBe('晚饭后有点胀');
  });

  it('保存失败时提示错误且不谎报成功', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: '发生时间不能晚于现在' } }),
    );
    const onSaved = vi.fn();
    render(<RecordSheet mode="meal" defaultMealType="lunch" onClose={vi.fn()} onSaved={onSaved} />);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('发生时间不能晚于现在'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
