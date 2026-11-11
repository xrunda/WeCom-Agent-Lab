import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import ConsoleApp from '../src/App.tsx';
import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { MOCK_PASSWORD, getTenant, login } from '../src/mock/api.ts';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

async function renderAt(path: string, username = 'admin') {
  await login(username, MOCK_PASSWORD);
  return render(
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

describe('WP-L 配置页', () => {
  it('知识库显示分类树、条目与命中次数', async () => {
    await renderAt('/knowledge');

    expect(await screen.findByText('晚餐建议在 19 点前完成')).toBeInTheDocument();
    expect(screen.getAllByText('饮食建议').length).toBeGreaterThan(0);
    expect(screen.getByText(/全部分类/)).toBeInTheDocument();
    expect(screen.getByText('12 次')).toBeInTheDocument();
  });

  it('风险规则区分内置红线与关键词规则', async () => {
    await renderAt('/rules');

    expect(await screen.findByText('不诊断')).toBeInTheDocument();
    expect(screen.getByText('急症-胸痛')).toBeInTheDocument();
    expect(screen.getAllByText('内置红线').length).toBeGreaterThan(0);
    expect(screen.getByText(/内置规则由平台维护/)).toBeInTheDocument();
  });

  it('话术库展示示例数据标签与话术卡片', async () => {
    await renderAt('/scripts');

    expect(await screen.findByText('首次服务问候')).toBeInTheDocument();
    expect(screen.getAllByText('示例数据').length).toBeGreaterThan(0);
    expect(screen.getByText('团队常用表达示例，可按分类查找并复制到企微。')).toBeInTheDocument();
  });
});

describe('WP-L 工作台与报表', () => {
  it('工作台显示价值条、KPI 与示例标签', async () => {
    await renderAt('/dashboard');

    expect(await screen.findByText('每一条草稿，都在为顾问省时间')).toBeInTheDocument();
    expect(screen.getByText('在线 Agent')).toBeInTheDocument();
    expect(screen.getByText('价值速览 · 今日')).toBeInTheDocument();
    expect(screen.getAllByText('示例').length).toBeGreaterThan(0);
    expect(screen.getAllByText('核验通过率').length).toBeGreaterThan(0);
  });

  it('数据报表显示自洽的示例摘要', async () => {
    await renderAt('/reports');

    expect(await screen.findByText('服务量与核验趋势')).toBeInTheDocument();
    expect(screen.getAllByText('420').length).toBeGreaterThan(0);
    expect(screen.getByText(/本页为预置示例/)).toBeInTheDocument();
    expect(screen.getByText('顾问对比')).toBeInTheDocument();
  });
});

describe('WP-L 技能与方案包', () => {
  it('技能市场显示已启用与即将上线', async () => {
    await renderAt('/skills');

    expect(await screen.findByText('餐食图片识别')).toBeInTheDocument();
    expect(screen.getByText('体检报告解读')).toBeInTheDocument();
    expect(screen.getByText('消息通道、记忆、红线与知识问答，都以插件形式工作')).toBeInTheDocument();
  });

  it('C 档技能卡片可进入介绍页', async () => {
    await renderAt('/skills/skl_device');

    expect(await screen.findByText('智能设备数据接入 · 即将上线')).toBeInTheDocument();
    expect(screen.getByText(/接入血糖、血压等设备数据/)).toBeInTheDocument();
  });

  it('行业方案包显示已启用方案与 C 档介绍页', async () => {
    await renderAt('/solutions');

    expect(await screen.findByText('健康调理服务')).toBeInTheDocument();
    expect(screen.getByText('知识条目')).toBeInTheDocument();
    expect(screen.getByText('体重与代谢管理')).toBeInTheDocument();
  });

  it('C 档方案包可进入介绍页', async () => {
    await renderAt('/solutions/spk_tcm');
    expect(await screen.findByText('中医调理 · 即将上线')).toBeInTheDocument();
  });
});

describe('WP-L 系统设置', () => {
  it('Agent 设定保存后机构配置立即更新', async () => {
    await renderAt('/settings/agent');

    const input = await screen.findByDisplayValue('小安');
    expect(screen.queryByText('当前角色不能修改 Agent 设定')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '小康' } });
    fireEvent.click(screen.getByRole('button', { name: /保存\s*设定/ }));

    await waitFor(async () => {
      expect((await getTenant()).agentName).toBe('小康');
    });
    expect(screen.getByText(/已保存，下一条草稿与沙盒中的名字立即同步/)).toBeInTheDocument();
  });

  it('只读账号能查看 Agent 设定但不能修改', async () => {
    await renderAt('/settings/agent', 'viewer');

    expect(await screen.findByDisplayValue('小安')).toBeDisabled();
    expect(screen.getByText('当前角色不能修改 Agent 设定')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存\s*设定/ })).not.toBeInTheDocument();
  });

  it('企微接入状态四路正常，演示断开后转红', async () => {
    await renderAt('/settings/wecom');

    expect(await screen.findByText('四路接入均正常')).toBeInTheDocument();
    expect(screen.getByText('存档 SDK')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('接入状态需要关注')).toBeInTheDocument();
  });

  it('AI 模型页显示模型与降级统计', async () => {
    await renderAt('/settings/model');

    expect(await screen.findByText('deepseek-v4.1-flash')).toBeInTheDocument();
    expect(screen.getByText('今日调用')).toBeInTheDocument();
    expect(screen.getAllByText('降级次数').length).toBeGreaterThan(0);
  });

  it('管理员可见账号写操作与权限矩阵', async () => {
    await renderAt('/settings/accounts');

    expect(await screen.findByText('新建账号')).toBeInTheDocument();
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByText('权限矩阵')).toBeInTheDocument();
    expect(screen.getAllByText('机构管理员').length).toBeGreaterThan(0);
  });

  it('只读账号看不到账号写操作', async () => {
    await renderAt('/settings/accounts', 'viewer');

    expect(await screen.findByText('无权查看账号与角色')).toBeInTheDocument();
    expect(screen.queryByText('新建账号')).not.toBeInTheDocument();
    expect(screen.queryByText('重置密码')).not.toBeInTheDocument();
  });

  it('管理员可导出审计 CSV，只读账号看不到导出', async () => {
    await renderAt('/settings/audit');

    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(screen.getByText('导出 CSV')).toBeInTheDocument();
  });

  it('只读账号可以查看审计但不能导出', async () => {
    await renderAt('/settings/audit', 'viewer');

    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(screen.queryByText('导出 CSV')).not.toBeInTheDocument();
  });
});
