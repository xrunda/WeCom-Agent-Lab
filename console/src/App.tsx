import { Spin } from 'antd';
import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthContext.tsx';
import { NotConnectedPage } from './components/NotConnectedPage.tsx';
import { ConsoleLayout } from './layout/ConsoleLayout.tsx';
import { isMockMode } from './mock/http.ts';
import AlertsPage from './pages/alerts/index.tsx';
import DashboardPage from './pages/dashboard/index.tsx';
import AdvisorsPage from './pages/advisors/index.tsx';
import CheckinsPage from './pages/checkins/index.tsx';
import GroupsPage from './pages/groups/index.tsx';
import KnowledgePage from './pages/knowledge/index.tsx';
import { LoginPage } from './pages/login/LoginPage.tsx';
import NotFoundPage from './pages/NotFoundPage.tsx';
import PatientsPage from './pages/patients/index.tsx';
import ReportsPage from './pages/reports/index.tsx';
import RulesPage from './pages/rules/index.tsx';
import SandboxPage from './pages/sandbox/index.tsx';
import ScriptsPage from './pages/scripts/index.tsx';
import ServiceFlowPage from './pages/service-flow/index.tsx';
import SettingsAccountsPage from './pages/settings/accounts/index.tsx';
import SettingsAgentPage from './pages/settings/agent/index.tsx';
import SettingsAuditPage from './pages/settings/audit/index.tsx';
import SettingsModelPage from './pages/settings/model/index.tsx';
import SettingsOnboardingPage from './pages/settings/onboarding/index.tsx';
import SettingsSecurityPage from './pages/settings/security/index.tsx';
import SettingsWecomPage from './pages/settings/wecom/index.tsx';
import ShiftsPage from './pages/shifts/index.tsx';
import SkillDetailPage from './pages/skills/skill-detail.tsx';
import SkillsPage from './pages/skills/index.tsx';
import SolutionDetailPage from './pages/solutions/solution-detail.tsx';
import SolutionsPage from './pages/solutions/index.tsx';

/**
 * 真实模式下拦截尚未接入后端接口的模块。
 * mock 模式保持原样，页面里的示例数据仍可演示。
 */
function RealModeOnly({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  if (!isMockMode) {
    return <NotConnectedPage title={title} description={description} />;
  }
  return <>{children}</>;
}

function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="app-loading">
        <Spin size="large" />
        <div style={{ marginTop: 12, color: '#64748b' }}>正在加载…</div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<ConsoleLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route path="/service-flow" element={<ServiceFlowPage />} />
          <Route path="/sandbox" element={<SandboxPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/checkins" element={<CheckinsPage />} />
          <Route path="/advisors" element={<AdvisorsPage />} />
          <Route path="/shifts" element={<ShiftsPage />} />
          <Route
            path="/knowledge"
            element={
              <RealModeOnly title="知识库" description="分类维护知识条目；保存后重新生成 skill 资源。">
                <KnowledgePage />
              </RealModeOnly>
            }
          />
          <Route
            path="/rules"
            element={
              <RealModeOnly title="风险规则" description="健康红线与关键词规则。">
                <RulesPage />
              </RealModeOnly>
            }
          />
          <Route
            path="/scripts"
            element={
              <RealModeOnly title="话术库" description="团队常用表达，可按分类查找。">
                <ScriptsPage />
              </RealModeOnly>
            }
          />
          <Route
            path="/skills"
            element={
              <RealModeOnly title="技能市场" description="可插拔插件与已启用能力。">
                <SkillsPage />
              </RealModeOnly>
            }
          />
          <Route
            path="/skills/:skillId"
            element={
              <RealModeOnly title="技能详情">
                <SkillDetailPage />
              </RealModeOnly>
            }
          />
          <Route path="/reports" element={<ReportsPage />} />
          <Route
            path="/solutions"
            element={
              <RealModeOnly title="行业方案包" description="按行业组合知识、风险规则与技能。">
                <SolutionsPage />
              </RealModeOnly>
            }
          />
          <Route
            path="/solutions/:solutionId"
            element={
              <RealModeOnly title="方案包详情">
                <SolutionDetailPage />
              </RealModeOnly>
            }
          />
          <Route path="/settings/agent" element={<SettingsAgentPage />} />
          <Route
            path="/settings/wecom"
            element={
              <RealModeOnly
                title="企微接入状态"
                description="存档 SDK、机器人长连接、DSH Host 与席位状态。"
              >
                <SettingsWecomPage />
              </RealModeOnly>
            }
          />
          <Route
            path="/settings/model"
            element={
              <RealModeOnly title="AI 模型" description="模型服务、调用与用量。">
                <SettingsModelPage />
              </RealModeOnly>
            }
          />
          <Route path="/settings/accounts" element={<SettingsAccountsPage />} />
          <Route path="/settings/audit" element={<SettingsAuditPage />} />
          <Route path="/settings/security" element={<SettingsSecurityPage />} />
          <Route
            path="/settings/onboarding"
            element={
              <RealModeOnly title="开通正式服务" description="开通信息、前置条件与申请。">
                <SettingsOnboardingPage />
              </RealModeOnly>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
