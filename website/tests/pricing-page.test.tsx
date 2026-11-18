import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { SiteFooter, SiteHeader } from '../src/components/SiteChrome';
import { PricingPage } from '../src/pages/PricingPage';
import { NAV, WECOM_CONTACT_URL } from '../src/site';

function renderPage() {
  return render(
    <MemoryRouter>
      <SiteHeader />
      <PricingPage />
      <SiteFooter />
    </MemoryRouter>,
  );
}

describe('产品定价页', () => {
  it('导航与页尾包含「产品定价」，顺序在业务场景之后', () => {
    renderPage();
    const labels = NAV.map((item) => item.label);
    expect(labels).toEqual(['客户专属助手', '顾问工作台', '机构管理', '业务场景', '产品定价']);
    expect(screen.getAllByRole('link', { name: '产品定价' }).length).toBeGreaterThanOrEqual(2);
  });

  it('展示种子合作参考价、范围与三项关键说明', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('把平台服务费和企微存档费算清楚。');
    expect(screen.getByText('¥19,800')).toBeInTheDocument();
    expect(screen.getByText('种子合作参考价，实际报价及服务范围以双方确认的方案为准。')).toBeInTheDocument();
    expect(screen.getByText('按 10 位顾问规划，控制台管理员账号不单独计费、不占顾问席位。')).toBeInTheDocument();
  });

  it('四项能力与企微存档费分开列，金额带示例口径', () => {
    renderPage();
    for (const title of ['客户专属助手', '主动跟进', '企业微信顾问助手', '机构管理']) {
      expect(screen.getAllByRole('heading', { level: 3, name: title }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('10 位顾问 × 900 元 / 人 / 年')).toBeInTheDocument();
    expect(screen.getByText('≈ 9,000 元 / 年')).toBeInTheDocument();
    expect(screen.getByText('示例金额 · 不含在平台服务费内')).toBeInTheDocument();
  });

  it('预约按钮沿用站点现有预约方式，锚点指向方案范围', () => {
    renderPage();
    const ctas = screen.getAllByRole('link', { name: /预约演示/ });
    expect(ctas.length).toBeGreaterThanOrEqual(3);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute('href', WECOM_CONTACT_URL);
      expect(cta).toHaveAttribute('target', '_blank');
    }
    expect(screen.getByRole('link', { name: /查看方案包含什么/ })).toHaveAttribute('href', '#included');
  });

  it('常见问题三条齐全', () => {
    renderPage();
    const faq = screen.getByRole('heading', { level: 2, name: '常见问题' }).closest('section') as HTMLElement;
    const qs = within(faq).getAllByRole('term').map((el) => el.textContent);
    expect(qs).toEqual(['怎样算一位顾问？', '客户需要换软件吗？', '合作怎么开始？']);
  });
});
