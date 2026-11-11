import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ReactNode } from 'react';

import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { MOCK_PASSWORD, login, resetMockState } from '../src/mock/api.ts';
import { resetAdvisorsMock } from '../src/mock/advisors.ts';
import { resetGroupsMock } from '../src/mock/groups.ts';
import { resetPatientsMock } from '../src/mock/patients.ts';
import AdvisorsPage from '../src/pages/advisors/index.tsx';
import GroupsPage from '../src/pages/groups/index.tsx';
import PatientsPage from '../src/pages/patients/index.tsx';

async function renderPage(node: ReactNode) {
  await login('admin', MOCK_PASSWORD);
  render(
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>{node}</AuthProvider>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  );
}

beforeEach(() => {
  resetMockState();
  resetPatientsMock();
  resetGroupsMock();
  resetAdvisorsMock();
});

describe('WP-K 页面', () => {
  it('患者卡片墙与 Agent 主页 Tab 可用', async () => {
    const user = userEvent.setup();
    await renderPage(<PatientsPage />);

    await waitFor(() => expect(screen.getByText('张女士')).toBeInTheDocument());
    expect(screen.getByText('刘先生')).toBeInTheDocument();
    expect(screen.getByText('孙女士')).toBeInTheDocument();

    await user.click(screen.getByText('张女士'));

    // 基本信息是第一个 Tab，默认展开
    expect(await screen.findByRole('tab', { name: '基本信息' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '记忆' }));
    expect(await screen.findByText('对海鲜过敏')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '记忆' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '主动计划' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '办事记录' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '对话时间线' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '健康档案' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '服务计划' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '主动计划' }));
    expect(await screen.findByText('提醒量血压')).toBeInTheDocument();
  });

  it('服务群页面展示待确认提示与群列表', async () => {
    await renderPage(<GroupsPage />);

    expect(await screen.findByText('有 1 个待确认群')).toBeInTheDocument();
    expect(await screen.findByText('糖友-张女士')).toBeInTheDocument();
    expect(screen.getByText('外部成员 8f2a1c')).toBeInTheDocument();
  });

  it('顾问页面展示席位成本与暂停状态', async () => {
    await renderPage(<AdvisorsPage />);

    expect(await screen.findByText('已购席位')).toBeInTheDocument();
    expect(screen.getByText('3 席 × ¥900 / 人 / 年')).toBeInTheDocument();
    expect(screen.getByText('李顾问')).toBeInTheDocument();
    expect(screen.getByText('赵顾问')).toBeInTheDocument();
  });
});
