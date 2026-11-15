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

async function renderPage(node: ReactNode, initialEntries: string[] = ['/']) {
  await login('admin', MOCK_PASSWORD);
  render(
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <MemoryRouter initialEntries={initialEntries}>
          <AuthProvider>{node}</AuthProvider>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  );
}

function cardOf(text: string | RegExp): HTMLElement {
  const node = screen.getAllByText(text).find((element) => element.closest('.alert-card'));
  if (!node?.closest('.alert-card')) throw new Error(`找不到包含「${String(text)}」的告警卡片`);
  return node.closest('.alert-card') as HTMLElement;
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

  it('告警页只显示员工群发言红线，并可写备注标记已处理', async () => {
    const user = userEvent.setup();
    await renderPage(<AlertsPage />);

    // 只收 source=staff 的发言告警：李顾问在「糖友-张女士」群里的原话
    expect(await screen.findAllByText('李顾问')).not.toHaveLength(0);
    expect(screen.getAllByText(/糖友-张女士/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('不诊断').length).toBeGreaterThan(0);
    // 发错群、未核验、顾问暂停等运维告警不在本页
    expect(screen.queryByText('草稿未核验')).not.toBeInTheDocument();
    expect(screen.queryByText('顾问被暂停')).not.toBeInTheDocument();

    const card = cardOf(/糖友-张女士/);
    await user.click(within(card).getByText('标记已处理'));

    const textarea = await screen.findByPlaceholderText('填写处理备注（必填，≤200 字）');
    await user.type(textarea, '已在群里更正并提醒顾问');
    await user.click(screen.getByText('确认处理'));

    await waitFor(() => {
      expect(within(cardOf(/糖友-张女士/)).getByText('已处理')).toBeInTheDocument();
    });
  });

  it('告警详情抽屉按「发言 → 规则 → 告警」说明因果链', async () => {
    const user = userEvent.setup();
    await renderPage(<AlertsPage />);

    await screen.findAllByText('李顾问');
    const card = cardOf(/糖友-张女士/);
    await user.click(within(card).getByText('查看详情'));

    expect(await screen.findByText('发言告警详情')).toBeInTheDocument();
    expect(await screen.findByText('员工发言')).toBeInTheDocument();
    expect(screen.getAllByText('命中规则').length).toBeGreaterThan(0);
    expect(screen.getByText('生成告警')).toBeInTheDocument();
    // 明确标出原话里触发告警的关键词
    expect(screen.getByText(/命中词/)).toBeInTheDocument();
    expect(screen.getByText('怎么处理')).toBeInTheDocument();
    expect(screen.getByText('处理情况')).toBeInTheDocument();
  });

  it('深链 ?draftId= 直接打开服务流详情抽屉', async () => {
    await renderPage(<ServiceFlowPage />, ['/service-flow?draftId=draft_1007']);

    expect(await screen.findByRole('tab', { name: '时间线' })).toBeInTheDocument();
    expect(screen.getByText('draft_1007')).toBeInTheDocument();
  });

  it('深链 ?patientId= 按患者筛选服务流并允许清除', async () => {
    const user = userEvent.setup();
    await renderPage(<ServiceFlowPage />, ['/service-flow?patientId=pat_03']);

    expect(await screen.findByText(/已按患者筛选/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));

    await waitFor(() => {
      expect(screen.queryByText(/已按患者筛选/)).not.toBeInTheDocument();
    });
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
