/**
 * 患者端 H5 根组件（PH5-02 #231）。
 *
 * 极简 hash 路由（PH5-03 建完整骨架后替换为四导航结构）：
 * #/login 登录/兑换 → #/consents 授权 → #/privacy 隐私 → #/me 状态。
 *
 * 邀请 code 处理（契约 api §1.7，A01）：
 * - 从 ?code= 读取后立即 history.replaceState 清掉 URL 参数
 * - 只存内存 state，不写 localStorage；兑换成功后即清除
 */
import { useCallback, useEffect, useState } from 'react';

import { ApiError, fetchMe, logout, reportEvent } from './api.ts';
import { ConsentsPage } from './pages/ConsentsPage.tsx';
import { InviteLoginPage } from './pages/InviteLoginPage.tsx';
import { MePage } from './pages/MePage.tsx';
import { PrivacyPage } from './pages/PrivacyPage.tsx';

export type AppStage = 'boot' | 'login' | 'ready';

/** 从地址栏提取一次性邀请码并立即清理 URL（不进入历史与分享链接） */
export function extractInviteCode(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    params.delete('code');
    const rest = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`,
    );
  }
  return code;
}

export function App() {
  const [stage, setStage] = useState<AppStage>('boot');
  const [hash, setHash] = useState<string>(() => window.location.hash || '#/login');
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  const navigate = useCallback((next: string) => {
    window.location.hash = next;
    setHash(next);
  }, []);

  useEffect(() => {
    // 启动时先抽取邀请码（清理 URL），再探测会话
    const code = extractInviteCode();
    if (code) setInviteCode(code);
    fetchMe()
      .then(() => {
        setStage('ready');
        void reportEvent('h5.session_start');
      })
      .catch(() => {
        setStage('login');
        if (!window.location.hash) navigate('#/login');
      });
  }, [navigate]);

  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash || '#/login');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (stage === 'boot') {
    return (
      <div className="page page-center">
        <div className="boot-card" role="status" aria-label="正在加载">
          <div className="logo-mark" aria-hidden="true" />
          <p className="muted">正在进入知伴健康…</p>
        </div>
      </div>
    );
  }

  if (stage === 'login') {
    return (
      <InviteLoginPage
        inviteCode={inviteCode}
        onDone={(code) => {
          if (code) setInviteCode(null);
          setStage('ready');
          navigate('#/consents');
        }}
      />
    );
  }

  const route = hash.replace(/^#/, '') || '/me';
  if (route.startsWith('/consents')) {
    return <ConsentsPage onUnauthorized={() => setStage('login')} />;
  }
  if (route.startsWith('/privacy')) {
    return <PrivacyPage onUnauthorized={() => setStage('login')} />;
  }
  return (
    <MePage
      onLogout={async () => {
        try {
          await logout();
        } catch (error) {
          // 会话已失效也算登出成功路径
          if (!(error instanceof ApiError && error.status === 401)) {
            // 其余错误不阻塞本地清理
          }
        }
        setStage('login');
        navigate('#/login');
      }}
      onNavigate={navigate}
    />
  );
}
