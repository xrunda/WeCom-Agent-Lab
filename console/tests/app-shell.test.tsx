import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import ConsoleApp from '../src/App.tsx';
import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { MOCK_PASSWORD, login, updateTenant } from '../src/mock/api.ts';

async function renderConsole(path = '/dashboard') {
  await login('admin', MOCK_PASSWORD);
  render(
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <ConsoleApp />
          </AuthProvider>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('控制台外壳', () => {
  it('登录后进入工作台，外壳与页面骨架正常渲染', async () => {
    await renderConsole('/dashboard');

    await waitFor(() => expect(screen.getByText('每一条草稿，都在为顾问省时间')).toBeInTheDocument());
    // jsdom 下 ProLayout 不渲染侧边菜单（菜单结构由 menu.test.tsx 覆盖），
    // 这里验证外壳其余部分：模式标识、称谓控件与页面标题。
    expect(screen.getByText('MOCK')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '切换服务对象称谓' })).toBeInTheDocument();
    expect(screen.getAllByText('工作台').length).toBeGreaterThan(0);
  });

  it('称谓改为会员后，菜单与患者页标题同步', async () => {
    await login('admin', MOCK_PASSWORD);
    await updateTenant({ patientTerm: '会员' });

    render(
      <ConfigProvider locale={zhCN}>
        <AntApp>
          <MemoryRouter initialEntries={['/patients']}>
            <AuthProvider>
              <ConsoleApp />
            </AuthProvider>
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>,
    );

    // 顶栏面包屑与页面标题各出现一次，都应随称谓同步。
    await waitFor(() => expect(screen.getAllByText('会员 Agent').length).toBeGreaterThan(1));
  });
});
