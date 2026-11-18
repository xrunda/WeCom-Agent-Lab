import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DemoPage, WECOM_CONTACT_URL } from '../src/pages/DemoPage';

describe('预约演示页', () => {
  it('用企微获客链接替代表单', () => {
    render(
      <MemoryRouter>
        <DemoPage />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /打开企业微信/ });
    expect(link).toHaveAttribute('href', WECOM_CONTACT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));

    expect(screen.getByRole('img', { name: /企业微信二维码/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('添加顾问企业微信')).toBeInTheDocument();
  });
});
