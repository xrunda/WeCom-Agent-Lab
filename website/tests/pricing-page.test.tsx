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

  it('展示种子合作参考价、10 个席位与企微存档必须另购', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('把平台服务费和企微存档费算清楚。');
    expect(screen.getByText('¥19,800')).toBeInTheDocument();
    expect(screen.getByText('种子合作参考价，实际报价及服务范围以双方确认的方案为准。')).toBeInTheDocument();

    const scope = container.querySelector('.price-card__scope')?.textContent ?? '';
    expect(scope).toContain('含 10 个顾问席位');
    expect(scope).toContain('控制台管理员账号不单独计费、不占顾问席位');

    const note = container.querySelector('.price-card__scope--note')?.textContent ?? '';
    expect(note).toContain('还需为每位顾问单独购买企微会话存档');
  });

  it('权益以表格列出全部能力，并按四组归类', () => {
    renderPage();
    const table = screen.getByRole('table', { name: '种子合作方案包含的产品能力' });
    // 四个分组标题
    for (const group of ['客户专属助手', '顾问在企微里', '质量与安全', '机构管理']) {
      expect(within(table).getByText(group)).toBeInTheDocument();
    }
    // 各能力行以行首单元格列出
    const names = within(table).getAllByRole('rowheader').map((el) => el.textContent);
    for (const name of ['长期记忆', '主动计划', '自然语言查询', '回复草稿', '回读核验', '团队关注', '价值看板']) {
      expect(names).toContain(name);
    }
    expect(within(table).getAllByRole('img', { name: '包含' }).length).toBeGreaterThanOrEqual(20);
  });

  it('企微存档费写明由企微收取、必须开通才能使用', () => {
    renderPage();
    expect(screen.getByText('10 位顾问 × 900 元 / 人 / 年')).toBeInTheDocument();
    expect(screen.getByText('≈ 9,000 元 / 年')).toBeInTheDocument();
    expect(screen.getByText('付给企业微信 · 不含在 19,800 元 / 月的平台服务费内')).toBeInTheDocument();
    expect(screen.getByText(/没有开通存档的顾问，无法使用知伴的客户群服务/)).toBeInTheDocument();
    expect(screen.queryByText(/示例金额/)).toBeNull();
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
