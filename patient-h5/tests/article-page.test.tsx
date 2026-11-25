/**
 * PH5-08 文章详情：经典原文与白话分别标注、下架显示「内容已更新」。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticlePage } from '../src/pages/ArticlePage.tsx';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ArticlePage（H08）', () => {
  it('经典原文带出处并标注，白话解释单独标注', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'art_1',
        category: 'classics_life',
        title: '从「五谷为养」读懂一日三餐',
        summary: '主食与配菜的关系',
        sections: [
          {
            kind: 'classic_quote',
            text: '五谷为养，五果为助，五畜为益，五菜为充',
            citation: '《黄帝内经·素问·脏气法时论》',
            verified: true,
          },
          { kind: 'plain_explanation', text: '主食养身，果菜相助。' },
        ],
        authorName: '编辑部',
        citations: [],
        publishedAt: Date.now(),
        version: 2,
      }),
    );
    render(<ArticlePage articleId="art_1" onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('五谷为养，五果为助，五畜为益，五菜为充')).toBeInTheDocument());
    expect(screen.getByText(/出处：《黄帝内经/)).toBeInTheDocument();
    expect(screen.getByText('经典原文')).toBeInTheDocument();
    expect(screen.getByText('白话解释')).toBeInTheDocument();
    expect(screen.getByText(/不构成诊断或用药建议/)).toBeInTheDocument();
  });

  it('内容下架时显示「内容已更新」而不是空白', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: '内容已更新' } }),
    );
    render(<ArticlePage articleId="art_gone" onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('内容已更新')).toBeInTheDocument());
  });

  it('食材类显示适用条件与注意事项', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'art_2',
        category: 'ingredients',
        title: '认识食材：小米',
        summary: '日常吃法',
        sections: [{ kind: 'modern_life', text: '小米很常见。' }],
        authorName: '编辑部',
        citations: [],
        ingredientSafety: { usage: '煮粥', conditions: '一般人群', cautions: '脾胃虚寒者少量' },
        publishedAt: Date.now(),
        version: 1,
      }),
    );
    render(<ArticlePage articleId="art_2" onBack={vi.fn()} onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('食用方式与注意')).toBeInTheDocument());
    expect(screen.getByText('脾胃虚寒者少量')).toBeInTheDocument();
  });
});
