import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from '../src/pages/HomePage';
import { PLAN } from '../src/plan';

function renderHome() {
  const utils = render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
  return {
    ...utils,
    humanPanel: document.getElementById('hero-panel-human') as HTMLElement,
    agentPanel: document.getElementById('hero-panel-agent') as HTMLElement,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('首页双通道', () => {
  it('默认给人看，切换到「给 Agent 看」后展示机器卡', async () => {
    const { humanPanel, agentPanel } = renderHome();
    const human = screen.getByRole('tab', { name: '给人看' });
    const agent = screen.getByRole('tab', { name: '给 Agent 看' });

    expect(human).toHaveAttribute('aria-selected', 'true');
    expect(agent).toHaveAttribute('aria-selected', 'false');
    expect(humanPanel.hasAttribute('hidden')).toBe(false);
    expect(agentPanel.hasAttribute('hidden')).toBe(true);

    fireEvent.click(agent);
    expect(agent).toHaveAttribute('aria-selected', 'true');
    expect(humanPanel.hasAttribute('hidden')).toBe(true);
    expect(agentPanel.hasAttribute('hidden')).toBe(false);

    const card = agentPanel;
    expect(within(card).getByText('GET')).toBeInTheDocument();
    expect(within(card).getByText('/llms.txt')).toBeInTheDocument();
    expect(within(card).getByText(new RegExp(`¥${PLAN.priceLabel}`))).toBeInTheDocument();
    expect(within(card).getByText(new RegExp(`${PLAN.seats} 个顾问席位`))).toBeInTheDocument();
    expect(within(card).getByText(/不做诊断/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /打开 llms\.txt/ })).toHaveAttribute('href', '/llms.txt');
  });

  it('首屏常驻 llms.txt 入口，喂给 Agent 的提示词可复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderHome();
    expect(screen.getByRole('link', { name: /\/llms\.txt/ })).toHaveAttribute('href', '/llms.txt');

    fireEvent.click(screen.getByRole('tab', { name: '给 Agent 看' }));
    fireEvent.click(screen.getByRole('button', { name: /复制给 Agent 的提问/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('https://zhiban.xrunda.com/llms.txt');
    expect(await screen.findByRole('button', { name: /已复制/ })).toBeInTheDocument();
  });
});
