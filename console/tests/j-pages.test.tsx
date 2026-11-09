import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { MOCK_PASSWORD, login, resetMockState } from '../src/mock/api.ts';
import { resetAdvisorsMock } from '../src/mock/advisors.ts';
import { resetAlertsMock } from '../src/mock/alerts.ts';
import { resetGroupsMock } from '../src/mock/groups.ts';
import { resetPatientsMock } from '../src/mock/patients.ts';
import { resetSandboxMock } from '../src/mock/sandbox.ts';
import { resetServiceFlowMock } from '../src/mock/service-flow.ts';
import AlertsPage from '../src/pages/alerts/index.tsx';
import PatientsPage from '../src/pages/patients/index.tsx';
import SandboxPage from '../src/pages/sandbox/index.tsx';
import ServiceFlowPage from '../src/pages/service-flow/index.tsx';

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

function rowOf(text: string): HTMLElement {
  const node = screen.getAllByText(text).find((element) => element.closest('tr'));
  if (!node?.closest('tr')) throw new Error(`找不到包含「${text}」的表格行`);
  return node.closest('tr') as HTMLElement;
}

beforeEach(() => {
  resetMockState();
  resetPatientsMock();
  resetGroupsMock();
  resetAdvisorsMock();
  resetAlertsMock();
  resetServiceFlowMock();
  resetSandboxMock();
});

describe('WP-J 页面', () => {
  it('实时服务流展示草稿列表并打开详情抽屉', async () => {
    const user = userEvent.setup();
    await renderPage(<ServiceFlowPage />);

    expect(await screen.findByText('晚上吃点什么好')).toBeInTheDocument();

    await user.click(screen.getByText('晚上吃点什么好'));

    expect(await screen.findByRole('tab', { name: '时间线' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '草稿与实发' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /引用依据/ })).toBeInTheDocument();
  });

  it('告警页可以写备注标记已处理', async () => {
    const user = userEvent.setup();
    await renderPage(<AlertsPage />);

    await screen.findByText('草稿未核验');
    expect(screen.getAllByText('发错群').length).toBeGreaterThan(0);
    expect(screen.getAllByText('顾问被暂停').length).toBeGreaterThan(0);

    const row = rowOf('草稿未核验');
    await user.click(within(row).getByText('标记已处理'));

    const textarea = await screen.findByPlaceholderText('填写处理备注（必填，≤200 字）');
    await user.type(textarea, '已电话确认顾问补发');
    await user.click(screen.getByText('确认处理'));

    await waitFor(() => {
      expect(within(rowOf('草稿未核验')).getByText('已处理')).toBeInTheDocument();
    });
  });

  it('告警详情抽屉展示关联对象与入口', async () => {
    const user = userEvent.setup();
    await renderPage(<AlertsPage />);

    await screen.findByText('草稿未核验');
    const row = rowOf('发错群');
    await user.click(within(row).getByText('查看'));

    expect(await screen.findByText('告警详情')).toBeInTheDocument();
    expect(await screen.findByText('去服务流查看')).toBeInTheDocument();
  });

  it('沙盒三栏联动：记忆、草稿与核验结果', async () => {
    const user = userEvent.setup();
    await renderPage(<SandboxPage />);

    expect(await screen.findByText('体验沙盒 · 不连接真实客户群')).toBeInTheDocument();
    expect(screen.getByText('模拟客户群')).toBeInTheDocument();
    expect(screen.getByText('模拟顾问手机')).toBeInTheDocument();
    expect(screen.getByText('记忆面板')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /跳\s*过/ }));
    await user.click(screen.getByRole('button', { name: '我对海鲜过敏' }));

    expect(await screen.findByText('对海鲜过敏')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '晚上吃什么好' }));
    await waitFor(() => {
      expect(document.querySelector('.wecom-card-body')?.textContent).toContain('避开海鲜');
    });

    await user.click(screen.getByRole('button', { name: /照\s*发/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/核验结果：✅ 已核验/).length).toBeGreaterThan(0);
    });
  }, 15_000);

  it('患者 Agent 主页新增饮食记录 Tab', async () => {
    const user = userEvent.setup();
    await renderPage(<PatientsPage />);

    await user.click(await screen.findByText('张女士'));
    const tab = await screen.findByRole('tab', { name: '饮食记录' });
    await user.click(tab);

    expect(await screen.findByText('清蒸鲈鱼')).toBeInTheDocument();
    expect(screen.getByText('Agent 点评：')).toBeInTheDocument();
  });
});
