/**
 * PH5-07 团队页：提交留言、状态可追踪、「已收到」不等于已处理。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamPage } from '../src/pages/TeamPage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const team = {
  advisorName: '李顾问（虚构）',
  members: [{ name: '陈营养师（虚构）', role: '专业审核' }],
  serviceHours: '工作日 09:00–18:00',
  categories: [
    { key: 'plan', label: '计划问题' },
    { key: 'other', label: '其他' },
  ],
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fup_1',
    kind: 'question',
    message: '晚餐时间不固定怎么办',
    riskLevel: 'low',
    status: 'pending',
    assigneeName: null,
    claimedAt: null,
    resolvedAt: null,
    createdAt: Date.now(),
    overdue: false,
    ...overrides,
  };
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TeamPage（H10）', () => {
  it('展示真实名册与服务时间，不承诺 7×24', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, team));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    render(<TeamPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('李顾问（虚构）')).toBeInTheDocument());
    expect(screen.getByText(/工作日 09:00–18:00/)).toBeInTheDocument();
    expect(screen.queryByText(/7×24|全天候/)).not.toBeInTheDocument();
  });

  it('提交留言后提示已提交，但状态仍显示待接收', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, team));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { id: 'fup_1', status: 'pending', acknowledged: true }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, team));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [request()] }));

    render(<TeamPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/说说你遇到的情况/));
    await userEvent.type(screen.getByLabelText(/说说你遇到的情况/), '晚餐时间不固定怎么办');
    await userEvent.click(screen.getByRole('button', { name: '提交给专业团队' }));

    await waitFor(() => expect(screen.getByText(/已提交，团队看到会尽快跟进/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('待接收')).toBeInTheDocument());
    // 「已收到」不能显示成已处理
    expect(screen.queryByText('已处理')).not.toBeInTheDocument();
  });

  it('有未处理的风险类请求时提示及时就医', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, team));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { items: [request({ kind: 'risk', message: '晚饭后有点胀' })] }),
    );
    render(<TeamPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/如有紧急身体不适，请及时就医/)).toBeInTheDocument(),
    );
  });

  it('提交失败时报错，不谎报成功', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, team));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: '请填写说明' } }),
    );
    render(<TeamPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/说说你遇到的情况/));
    await userEvent.type(screen.getByLabelText(/说说你遇到的情况/), 'x');
    await userEvent.click(screen.getByRole('button', { name: '提交给专业团队' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('请填写说明'));
  });
});
