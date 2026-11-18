import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { SiteFooter, SiteHeader } from '../src/components/SiteChrome';
import { HomePage } from '../src/pages/HomePage';
import { ManagementPage } from '../src/pages/ManagementPage';
import { ScenariosPage } from '../src/pages/ScenariosPage';
import { WECOM_CONTACT_URL } from '../src/site';

function assertWecomLinks(): void {
  const links = screen.getAllByRole('link', { name: /预约演示/ });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link).toHaveAttribute('href', WECOM_CONTACT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  }
}

describe('预约入口直连企微', () => {
  it('首页的预约按钮直接指向企微获客链接', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    assertWecomLinks();
  });

  it('页头与页尾的预约入口直接指向企微获客链接', () => {
    render(
      <MemoryRouter>
        <SiteHeader />
        <SiteFooter />
      </MemoryRouter>,
    );
    assertWecomLinks();
  });

  it('机构管理页的预约按钮直接指向企微获客链接', () => {
    render(
      <MemoryRouter>
        <ManagementPage />
      </MemoryRouter>,
    );
    assertWecomLinks();
  });

  it('业务场景页的收尾按钮直接指向企微获客链接', () => {
    render(
      <MemoryRouter>
        <ScenariosPage />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /聊聊我们的服务场景/ });
    expect(link).toHaveAttribute('href', WECOM_CONTACT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
