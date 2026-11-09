import { Spin } from 'antd';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthContext.tsx';
import { ConsoleLayout } from './layout/ConsoleLayout.tsx';
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
import SkillsPage from './pages/skills/index.tsx';
import SolutionsPage from './pages/solutions/index.tsx';

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
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/scripts" element={<ScriptsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/solutions" element={<SolutionsPage />} />
          <Route path="/settings/agent" element={<SettingsAgentPage />} />
          <Route path="/settings/wecom" element={<SettingsWecomPage />} />
          <Route path="/settings/model" element={<SettingsModelPage />} />
          <Route path="/settings/accounts" element={<SettingsAccountsPage />} />
          <Route path="/settings/audit" element={<SettingsAuditPage />} />
          <Route path="/settings/security" element={<SettingsSecurityPage />} />
          <Route path="/settings/onboarding" element={<SettingsOnboardingPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
