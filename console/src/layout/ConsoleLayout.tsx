import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { ProLayout } from '@ant-design/pro-components';
import { Badge, Dropdown, Spin, Tag } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import logoUrl from '../assets/zhiban-logo.png';
import { useAuth, useTerm } from '../auth/AuthContext.tsx';
import { isMockMode } from '../mock/api.ts';
import { useAlertCount } from '../pages/alerts/useAlertCount.ts';
import { buildMenuItems } from './menu.tsx';
import { TenantTermControl } from './TenantTermControl.tsx';

export function ConsoleLayout() {
  const { session, tenant, loading, signOut } = useAuth();
  const term = useTerm();
  const location = useLocation();
  const navigate = useNavigate();
  const alertCount = useAlertCount();

  if (loading) {
    return (
      <div className="app-loading">
        <Spin size="large" />
        <div style={{ marginTop: 12, color: '#64748b' }}>正在加载控制台…</div>
      </div>
    );
  }

  if (!session || !tenant) return null;

  const menuItems = buildMenuItems(term);

  return (
    <ProLayout
      className="console-layout"
      title={false}
      logo={<img className="brand-logo" src={logoUrl} alt="知伴健康 Agent" />}
      layout="mix"
      navTheme="light"
      fixedHeader
      fixSiderbar
      siderWidth={236}
      location={{ pathname: location.pathname }}
      route={{ path: '/', children: menuItems }}
      menuItemRender={(item, dom) => {
        const showAlertBadge = item.path === '/alerts' && alertCount > 0;
        const label =
          item.soon || showAlertBadge ? (
            <span className="menu-label">
              {dom}
              {showAlertBadge && <Badge count={alertCount} size="small" />}
              {item.soon && (
                <Tag className="menu-soon-tag" color="gold" bordered={false}>
                  即将上线
                </Tag>
              )}
            </span>
          ) : (
            dom
          );
        return item.path ? <Link to={item.path}>{label}</Link> : label;
      }}
      onMenuHeaderClick={() => navigate('/dashboard')}
      menuFooterRender={() => (
        <div className="sider-tenant">
          <span className="sider-tenant-name">{tenant.name}</span>
          <span className="sider-tenant-agent">Agent：{tenant.agentName}</span>
        </div>
      )}
      actionsRender={() => [
        <TenantTermControl key="term" />,
        <Tag key="mode" color={isMockMode ? 'gold' : 'green'} bordered={false} className="mode-tag">
          {isMockMode ? 'MOCK' : 'LIVE'}
        </Tag>,
      ]}
      avatarProps={{
        icon: <UserOutlined />,
        title: session.account.displayName,
        render: (_props, dom) => (
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
            <span className="avatar-trigger">{dom}</span>
          </Dropdown>
        ),
      }}
      footerRender={() => (
        <footer className="console-footer">
          <span>知伴健康 Agent · P1 控制台</span>
          <span>{isMockMode ? '当前为 mock 模式，数据为虚构示例' : '已连接真实接口'}</span>
        </footer>
      )}
      token={{
        header: { colorBgHeader: '#ffffff' },
        pageContainer: { paddingInlinePageContainerContent: 24 },
      }}
    >
      <Outlet />
    </ProLayout>
  );
}

function roleName(role: string): string {
  if (role === 'admin') return '机构管理员';
  if (role === 'supervisor') return '主管';
  return '只读';
}
