import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { HealthProfileTab } from '../src/pages/patients/tabs/HealthProfileTab.tsx';
import { resetPatientsMock } from '../src/mock/patients.ts';

beforeEach(() => {
  resetPatientsMock();
});

function renderTab(canWrite = true) {
  return render(
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <HealthProfileTab patientId="pat_01" term="客户" canWrite={canWrite} />
      </AntApp>
    </ConfigProvider>,
  );
}

describe('慢病管理 Tab', () => {
  it('展示慢病标签、最新体征与来源', async () => {
    renderTab();
    await screen.findByText(/慢病概览/);
    expect(screen.getAllByText('血压').length).toBeGreaterThan(0);
    expect(screen.getAllByText('顾问录入').length).toBeGreaterThan(0);
    expect(screen.getAllByText('对话提取').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /录入体征/ })).toBeInTheDocument();
  });

  it('录入体征表单按指标切换字段', async () => {
    renderTab();
    await screen.findByText(/慢病概览/);
    fireEvent.click(screen.getByRole('button', { name: /录入体征/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeInTheDocument());
    expect(await screen.findByLabelText('收缩压')).toBeInTheDocument();
    expect(screen.getByLabelText('舒张压')).toBeInTheDocument();
  });

  it('只读账号看不到录入与编辑入口', async () => {
    renderTab(false);
    await screen.findByText(/慢病概览/);
    expect(screen.queryByRole('button', { name: /录入体征/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /编辑档案/ })).not.toBeInTheDocument();
  });
});
