/**
 * PH5-10 提醒偏好：只能更严格、保存失败如实提示。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrefsPage } from '../src/pages/PrefsPage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const prefs = {
  enabled: true,
  dailyLimit: 2,
  quietHours: { start: '21:00', end: '08:00' },
  gentleInquiry: true,
  tenantDefaults: { dailyLimit: 2, quietHours: { start: '21:00', end: '08:00' } },
};

beforeEach(() => fetchMock.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PrefsPage', () => {
  it('展示机构上限，只能调低的选项可用', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, prefs));
    render(<PrefsPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/机构上限是 2 次/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '2 次' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '0 次' })).toBeEnabled();
  });

  it('关闭提醒会发出 PATCH', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, prefs));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...prefs, enabled: false }));
    render(<PrefsPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => screen.getByRole('switch', { name: '接收提醒' }));
    await userEvent.click(screen.getByRole('switch', { name: '接收提醒' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
      expect(call).toBeDefined();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ enabled: false });
    });
  });

  it('保存失败如实提示', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, prefs));
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { code: 'INTERNAL', message: 'x' } }));
    render(<PrefsPage onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => screen.getByRole('button', { name: '1 次' }));
    await userEvent.click(screen.getByRole('button', { name: '1 次' }));
    await waitFor(() => expect(screen.getByText('保存失败，请重试')).toBeInTheDocument());
  });
});
