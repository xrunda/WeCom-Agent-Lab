/**
 * 患者端 H5 根组件（PH5-03：四导航骨架 + 建档流程）。
 *
 * 流程（PRD §4）：登录/兑换 → 授权 → 食养主张（可跳过）→ 分步建档 → 主应用。
 * 主应用四导航：今天 / 日历 / 食养 / 我的（区块固定、缺数据显示占位）。
 *
 * 邀请 code 处理（契约 api §1.7，A01）：从 ?code= 读取后立即清理 URL，
 * 只存内存，不写 localStorage。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, fetchMe, isDemoMode, logout, reportEvent } from './api.ts';
import type { MeResponse, ProfileStatusView } from './api.ts';
import { CalendarPage } from './pages/CalendarPage.tsx';
import { ConsentsPage } from './pages/ConsentsPage.tsx';
import { InviteLoginPage } from './pages/InviteLoginPage.tsx';
import { MePage } from './pages/MePage.tsx';
import { NurturePage } from './pages/NurturePage.tsx';
import { PrivacyPage } from './pages/PrivacyPage.tsx';
import { OnboardingWizard } from './pages/OnboardingWizard.tsx';
import { TodayPage } from './pages/TodayPage.tsx';

type Stage = 'boot' | 'login' | 'consents' | 'manifesto' | 'onboarding' | 'privacy' | 'app';
type Tab = 'today' | 'calendar' | 'nurture' | 'me';

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
  const [stage, setStage] = useState<Stage>('boot');
  const [tab, setTab] = useState<Tab>('today');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  const toLogin = useCallback(() => {
    setStage('login');
  }, []);

  const refreshMeRef = useRef<() => Promise<string | null>>(async () => null);

  // 启动：抽邀请码 → 探测会话 → 决定进入授权、建档还是主应用
  useEffect(() => {
    const code = extractInviteCode();
    if (code) setInviteCode(code);
    fetchMe()
      .then((value) => {
        setMe(value);
        // 回访用户：会话有效且已授权，按建档状态分流
        // 回访用户：未完成建档的先看主张页（可跳过），再进建档
        setStage(
          value.status === 'profile_incomplete' || value.status === 'data_pending'
            ? 'manifesto'
            : 'app',
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 403) {
          // 会话有效但 service_basic 未授权（或已撤回）
          setStage('consents');
          return;
        }
        setStage('login');
      });
  }, []);

  /** 供子组件使用的稳定引用：避免行内箭头函数导致 effect 反复触发（曾造成 /me 无限轮询） */
  const refreshMeStable = useCallback((): void => {
    void refreshMeRef.current();
  }, []);

  const refreshMe = useCallback(async (): Promise<string | null> => {
    try {
      const value = await fetchMe();
      setMe(value);
      return value.status;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setStage('login');
        return 'login';
      }
      return null;
    }
  }, []);

  refreshMeRef.current = refreshMe;

  const onLoggedIn = (usedInvite: boolean): void => {
    if (usedInvite) setInviteCode(null);
    // 会话开始事件由服务端在兑换/登录时记录，前端不重复上报
    setMe(null); // 新登录：丢弃上一个患者的残留状态
    setStage('consents');
  };

  const onOnboardingDone = async (_status: ProfileStatusView): Promise<void> => {
    void reportEvent('h5.profile_step_complete', { itemId: 'wizard_done' });
    const next = await refreshMe();
    setStage(next === 'login' ? 'login' : 'app');
  };

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
    return <InviteLoginPage inviteCode={inviteCode} onDone={onLoggedIn} />;
  }

  if (stage === 'consents') {
    return (
      <ConsentsPage
        onUnauthorized={toLogin}
        onDone={() => {
          // 必须重新拉 /me：启动 403 路径下 me 为 null，靠旧值会误判为需建档
          void (async () => {
            const status = await refreshMe();
            if (status === 'login') return;
            if (status === 'profile_incomplete' || status === 'data_pending' || status === null) {
              setStage('manifesto');
            } else {
              setStage('app');
            }
          })();
        }}
      />
    );
  }

  if (stage === 'privacy') {
    return <PrivacyPage onUnauthorized={toLogin} onDone={() => setStage('app')} />;
  }

  if (stage === 'manifesto') {
    // PRD §4：主张页在建档之前，可跳过；跳过不等于完成建档
    const nextStage = (): void => {
      setStage(me?.status === 'profile_incomplete' || me?.status === 'data_pending' ? 'onboarding' : 'app');
    };
    return (
      <NurturePage
        intro
        onStart={nextStage}
        onSkip={nextStage}
        onUnauthorized={toLogin}
      />
    );
  }

  if (stage === 'onboarding') {
    return (
      <OnboardingWizard
        onUnauthorized={toLogin}
        onDone={(status) => void onOnboardingDone(status)}
      />
    );
  }

  // ---------- 主应用：四导航 ----------
  return (
    <div>
      {isDemoMode() && (
        <div className="demo-banner" role="status">
          演示数据 · 非真实患者信息
        </div>
      )}
      {tab === 'today' && (
        <TodayPage
          statusHint={statusHintFor(me)}
          needOnboarding={me?.status === 'profile_incomplete' || me?.status === 'data_pending'}
          onStartOnboarding={() => setStage('onboarding')}
          onOpenCalendar={() => setTab('calendar')}
          onOpenNurture={() => setTab('nurture')}
          onUnauthorized={toLogin}
        />
      )}
      {tab === 'calendar' && (
        <CalendarPage onUnauthorized={toLogin} onBackToNurture={() => setTab('nurture')} />
      )}
      {tab === 'nurture' && <NurturePage onUnauthorized={toLogin} />}
      {tab === 'me' && (
        <MePage
          me={me}
          stats={demoStatsFor(me)}
          planSummary={demoPlanSummaryFor(me)}
          onLogout={async () => {
            try {
              await logout();
            } catch {
              // 会话已失效也走本地清理
            }
            setMe(null);
            setStage('login');
          }}
          onStartOnboarding={() => setStage('onboarding')}
          onOpenConsents={() => setStage('consents')}
          onOpenPrivacy={() => setStage('privacy')}
          onChanged={refreshMeStable}
        />
      )}
      <nav className="tabbar" aria-label="主导航">
        <TabButton active={tab === 'today'} onClick={() => setTab('today')} label="今天" icon="☀" />
        <TabButton
          active={tab === 'calendar'}
          onClick={() => setTab('calendar')}
          label="日历"
          icon="历"
        />
        <TabButton
          active={tab === 'nurture'}
          onClick={() => setTab('nurture')}
          label="食养"
          icon="养"
        />
        <TabButton active={tab === 'me'} onClick={() => setTab('me')} label="我的" icon="我" />
      </nav>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: string;
}) {
  return (
    <button
      type="button"
      className={active ? 'active' : ''}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/** 计划未就绪时在首页顶部给出的说明（PRD H03「无计划显示准备中」） */
function statusHintFor(me: MeResponse | null): { title: string; text: string } | null {
  switch (me?.status) {
    case 'profile_incomplete':
      return { title: '先完成建档', text: '回答几个小问题，我们才能为你准备合适的计划。' };
    case 'data_pending':
      return { title: '资料待补充', text: '有需要核对的信息，补充完成后开始准备计划。' };
    case 'plan_generating':
      return {
        title: '正在为你准备计划',
        text: '资料已收到，团队正在准备你的健康计划；完成后这里会显示今天的行动。',
      };
    case 'plan_suspended':
      return { title: '计划已暂停', text: '团队暂停了当前计划，如需了解请联系顾问。' };
    case 'service_paused':
      return { title: '服务已暂停', text: '当前服务暂停中，历史内容仍可查看。' };
    default:
      return null;
  }
}

/**
 * 演示模式的统计与计划摘要。
 * 真实接口目前不返回这两项（PH5-10 前），返回 undefined 让页面显示占位「—」，
 * 不用静态数字伪装真实统计（PRD §3.1）。
 */
function demoStatsFor(me: MeResponse | null): { meals?: number; reviews?: number } | undefined {
  if (!isDemoMode() || !me) return undefined;
  return { meals: 12, reviews: 4 };
}

function demoPlanSummaryFor(me: MeResponse | null): { name: string; stage: string } | null {
  if (!isDemoMode() || !me) return null;
  return { name: '食养陪伴', stage: '第 1 周 · 建立饮食节奏' };
}
