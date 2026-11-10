import { LogoutOutlined } from '@ant-design/icons';
import { ProLayout } from '@ant-design/pro-components';
import { Badge, Dropdown } from 'antd';
import { Fragment, useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import logoUrl from '../assets/zhiban-logo.png';
import { useAuth, useTerm } from '../auth/AuthContext.tsx';
import { isMockMode } from '../mock/api.ts';
import { useAlertCount } from '../pages/alerts/useAlertCount.ts';
import { buildMenuItems, findMenuTrail } from './menu.tsx';
import { TenantTermControl } from './TenantTermControl.tsx';
import './console-layout.css';

export function ConsoleLayout() {
  const { session, tenant, loading, signOut } = useAuth();
  const term = useTerm();
  const location = useLocation();
  const navigate = useNavigate();
  const alertCount = useAlertCount();
  // side 布局在桌面不渲染 ProLayout header；窄屏则用它自带的 header 承载菜单开关，
  // 此时把模式标识与账号菜单放进该 header，避免和自绘顶栏叠成两条。
  const isDesktop = useIsDesktop();

  if (loading) {
    return (
      <div className="app-loading">
        <span className="app-loading-text">正在加载控制台…</span>
      </div>
    );
  }

  if (!session || !tenant) return null;

  const menuItems = buildMenuItems(term);
  const trail = findMenuTrail(menuItems, location.pathname);

  const modeChip = (
    <span className={['mode-chip', isMockMode ? 'is-mock' : 'is-live'].join(' ')}>
      <span className="mode-chip-dot" aria-hidden="true" />
      <span className="mode-chip-name">{isMockMode ? 'MOCK' : 'LIVE'}</span>
      <span className="mode-chip-sub">{isMockMode ? '示例数据' : '真实接口'}</span>
    </span>
  );

  const accountMenu = (
    <Dropdown
      menu={{
        items: [
          {
            key: 'role',
            disabled: true,
            label: `角色：${roleName(session.account.role)}`,
          },
          { type: 'divider' },
          { key: 'logout', label: '退出登录', icon: <LogoutOutlined /> },
        ],
        onClick: ({ key }) => {
          if (key === 'logout') {
            void signOut().then(() => navigate('/login'));
          }
        },
      }}
    >
      <button
        type="button"
        className="avatar-trigger"
        aria-label={`${session.account.displayName}，${roleName(session.account.role)}，打开账号菜单`}
      >
        {session.account.displayName.slice(0, 1)}
      </button>
    </Dropdown>
  );

  return (
    <ProLayout
      className="console-layout"
      title={false}
      logo={logoUrl}
      layout="side"
      navTheme="light"
      fixSiderbar
      siderWidth={240}
      siderMenuType="group"
      location={{ pathname: location.pathname }}
      route={{ path: '/', children: menuItems }}
      menuHeaderRender={(logo) => (
        <Link to="/dashboard" className="console-brand" aria-label="知伴健康 Agent 工作台">
          {logo}
        </Link>
      )}
      menuItemRender={(item, dom) => {
        const showAlertBadge = item.path === '/alerts' && alertCount > 0;
        const label =
          item.soon || showAlertBadge ? (
            <div className="menu-label">
              <span className="menu-label-text">{dom}</span>
              {showAlertBadge && <Badge count={alertCount} size="small" />}
              {item.soon && <span className="menu-soon-flag">即将</span>}
            </div>
          ) : (
            dom
          );
        return item.path ? <Link to={item.path}>{label}</Link> : label;
      }}
      onMenuHeaderClick={() => navigate('/dashboard')}
      actionsRender={
        isDesktop
          ? undefined
          : () => [
              <Fragment key="mode">{modeChip}</Fragment>,
              <Fragment key="account">{accountMenu}</Fragment>,
            ]
      }
      menuFooterRender={() => (
        <div className="sider-tenant">
          <span className="sider-tenant-name">{tenant.name}</span>
          <span className="sider-tenant-agent">Agent：{tenant.agentName}</span>
        </div>
      )}
      footerRender={() => (
        <footer className="console-footer">
          <span>知伴健康 Agent · P1 控制台</span>
          <span>{isMockMode ? '当前为 mock 模式，数据为虚构示例' : '已连接真实接口'}</span>
        </footer>
      )}
      token={{
        header: {
          colorBgHeader: '#ffffff',
          colorHeaderTitle: '#102a32',
        },
        sider: {
          colorMenuBackground: '#ffffff',
          colorTextMenu: '#33484f',
          colorTextMenuSelected: '#0b5b55',
          colorTextMenuActive: '#0b5b55',
          colorBgMenuItemSelected: '#e9f2f0',
          colorBgMenuItemHover: '#fafcfb',
          colorMenuItemDivider: 'transparent',
          colorBgCollapsedButton: '#ffffff',
          colorTextCollapsedButtonHover: '#0f766e',
        },
        pageContainer: {
          paddingInlinePageContainerContent: 28,
          paddingBlockPageContainerContent: 26,
        },
      }}
    >
      <header className="console-topbar">
        <nav className="console-crumbs" aria-label="面包屑">
          {trail.map((name, index) => (
            <Fragment key={`${name}-${index}`}>
              {index > 0 ? <span className="console-crumbs-sep">/</span> : null}
              <span className={index === trail.length - 1 ? 'is-current' : undefined}>{name}</span>
            </Fragment>
          ))}
        </nav>
        <div className="console-topbar-actions">
          <TenantTermControl />
          {modeChip}
          {accountMenu}
        </div>
      </header>
      <Outlet />
    </ProLayout>
  );
}

/** 与 ProLayout 的 md 断点保持一致（768px），不依赖测试环境的 matchMedia stub。 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768);

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isDesktop;
}

function roleName(role: string): string {
  if (role === 'admin') return '机构管理员';
  if (role === 'supervisor') return '主管';
  return '只读';
}
