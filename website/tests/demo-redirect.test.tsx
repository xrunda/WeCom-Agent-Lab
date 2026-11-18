import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { WecomRedirectPage } from '../src/pages/WecomRedirectPage';
import { WECOM_CONTACT_URL } from '../src/site';

describe('旧预约入口 /demo', () => {
  it('渲染兜底按钮，并尝试跳转到企微获客链接', () => {
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, replace },
    });

    render(
      <MemoryRouter>
        <WecomRedirectPage />
      </MemoryRouter>,
    );

    expect(replace).toHaveBeenCalledWith(WECOM_CONTACT_URL);
    expect(document.title).toBe('预约演示 · 知伴健康');

    const link = screen.getByRole('link', { name: /打开企业微信/ });
    expect(link).toHaveAttribute('href', WECOM_CONTACT_URL);
    expect(link).toHaveAttribute('target', '_blank');

    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});
