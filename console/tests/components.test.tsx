import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AuthProvider, useTerm } from '../src/auth/AuthContext.tsx';
import { ComingSoonPage } from '../src/components/ComingSoonPage.tsx';
import { SampleDataTag } from '../src/components/SampleDataTag.tsx';
import { TenantTermControl } from '../src/layout/TenantTermControl.tsx';
import { MOCK_PASSWORD, login } from '../src/mock/api.ts';

function TermProbe() {
  const term = useTerm();
  return <div data-testid="term">{term}</div>;
}

describe('通用组件', () => {
  it('示例数据标签明确提示数据来源', () => {
    render(<SampleDataTag />);
    expect(screen.getByText('示例数据')).toBeInTheDocument();
  });

  it('C 档介绍页包含说明、示意图与联系开通', () => {
    render(
      <MemoryRouter>
        <ComingSoonPage title="健康打卡" description="打卡计划与依从性统计" />
      </MemoryRouter>,
    );

    expect(screen.getByText('健康打卡 · 即将上线')).toBeInTheDocument();
    expect(screen.getByText('申请开通')).toBeInTheDocument();
    expect(screen.getByText('方案确认')).toBeInTheDocument();
    expect(screen.getByText('上线使用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /联系开通/ })).toBeInTheDocument();
  });

  it('切换称谓后全局 term 立即变化', async () => {
    await login('admin', MOCK_PASSWORD);
    const user = userEvent.setup();

    render(
      <ConfigProvider locale={zhCN}>
        <App>
          <MemoryRouter>
            <AuthProvider>
              <TenantTermControl />
              <TermProbe />
            </AuthProvider>
          </MemoryRouter>
        </App>
      </ConfigProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('term')).toHaveTextContent('患者'));

    await user.click(screen.getByRole('combobox', { name: '切换服务对象称谓' }));
    const option = await screen.findByTitle('会员');
    await user.click(option);

    await waitFor(() => expect(screen.getByTestId('term')).toHaveTextContent('会员'));
  });

  it('齿轮可以保存自定义称谓', async () => {
    await login('admin', MOCK_PASSWORD);
    const user = userEvent.setup();

    render(
      <ConfigProvider locale={zhCN}>
        <App>
          <MemoryRouter>
            <AuthProvider>
              <TenantTermControl />
              <TermProbe />
            </AuthProvider>
          </MemoryRouter>
        </App>
      </ConfigProvider>,
    );

    await user.click(
      await screen.findByRole('button', { name: '自定义服务对象称谓' }),
    );
    const input = await screen.findByLabelText('自定义称谓输入');
    await user.clear(input);
    await user.type(input, '亲人');
    await user.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(screen.getByTestId('term')).toHaveTextContent('亲人'));
  });
});
