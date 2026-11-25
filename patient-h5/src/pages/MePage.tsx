/**
 * 「我的」页（H09，契约 api §4.1）。
 *
 * 结构按概念图：标题 → 头像与陪伴天数 → 健康计划卡 → 两项统计 →
 * 功能入口分组 → 页脚主张。
 *
 * 刻意隐藏「阶段回顾」：PRD §3.1 把它列为增强项，未实现不放无效入口。
 * 未实现的入口标「即将开放」而不是假装能点（PRD §3.1 不放无效按钮）。
 */
import { useEffect, useRef, useState } from 'react';

import { fetchMeStats, type MeResponse, type ProfileCenterStats } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { ASSETS } from '../assets.ts';

const STATUS_TEXT: Record<string, string> = {
  profile_incomplete: '资料待完善',
  data_pending: '资料待补充',
  plan_generating: '正在为你准备计划',
  plan_active: '计划执行中',
  plan_suspended: '计划已暂停',
  service_paused: '服务已暂停',
};

interface MeStats {
  /** 已记录餐食数（契约 /me 可选字段；PH5-10 前真实接口不返回） */
  meals?: number;
  /** 已完成回顾天数 */
  reviews?: number;
}

interface Props {
  me: MeResponse | null;
  /** 演示模式下的固定统计；真实模式忽略，改用 /me/stats */
  fallbackStats?: MeStats;
  planSummary?: { name: string; stage: string } | null;
  onLogout: () => void;
  onStartOnboarding: () => void;
  onOpenPlan: () => void;
  onOpenRecords: () => void;
  onOpenPrefs: () => void;
  onOpenConsents: () => void;
  onOpenPrivacy: () => void;
  onChanged: () => void;
}

export function MePage({
  me,
  fallbackStats,
  planSummary,
  onLogout,
  onStartOnboarding,
  onOpenPlan,
  onOpenRecords,
  onOpenPrefs,
  onOpenConsents,
  onOpenPrivacy,
  onChanged,
}: Props) {
  // 只在挂载时刷新一次；依赖 onChanged 会因父组件重渲染不断触发
  const [realStats, setRealStats] = useState<ProfileCenterStats | null>(null);

  useEffect(() => {
    fetchMeStats().then(setRealStats).catch(() => undefined);
  }, []);

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => {
    onChangedRef.current();
  }, []);

  const statusText = me ? (STATUS_TEXT[me.status] ?? me.status) : '…';
  const profilePending = me?.status === 'profile_incomplete' || me?.status === 'data_pending';
  const companionDays = realStats?.companionDays ?? me?.companionDays ?? null;

  const entries = [
    {
      key: 'profile',
      label: '我的健康档案',
      icon: 'doc' as IconName,
      ready: true,
      onClick: onStartOnboarding,
    },
    { key: 'records', label: '我的健康记录', icon: 'bowl' as IconName, ready: true, onClick: onOpenRecords },
    { key: 'team', label: '我的专业团队', icon: 'team' as IconName, ready: false, onClick: undefined },
  ] as const;

  return (
    <div className="page page-me">
      <header className="me-head">
        <h1>我的健康生活</h1>
        <AssetSlot id="I03" ratio="2 / 1" radius={0} label="枝叶装饰" className="me-head__deco" />
      </header>

      <section className="me-profile">
        <AssetSlot id="A01" ratio="1 / 1" radius={999} src={ASSETS.avatar} label="头像" className="me-avatar" />
        <div className="me-profile__body">
          <p className="me-profile__name">{me?.displayName ?? '我的资料'}</p>
          <p className="me-profile__meta">
            {companionDays !== null ? (
              <>
                与知伴相伴的第 <b>{companionDays}</b> 天
              </>
            ) : (
              statusText
            )}
          </p>
        </div>
        <button type="button" className="link-btn" onClick={onStartOnboarding}>
          编辑资料 ›
        </button>
      </section>

      <section className="me-plan-card">
        <div className="me-plan-card__body">
          <h2>我的健康计划</h2>
          <span className="me-plan-card__pill">{statusText}</span>
          <p className="me-plan-card__stage">{planSummary?.stage ?? '计划发布后显示本阶段重点'}</p>
        </div>
        <AssetSlot id="I05" ratio="1 / 1" radius={0} label="稻穗装饰" className="me-plan-card__deco" />
        <button
          type="button"
          className="btn btn-primary btn-inline me-plan-card__cta"
          onClick={onOpenPlan}
        >
          查看计划 →
        </button>
      </section>

      <section className="me-stats">
        <div className="me-stat">
          <AssetSlot id="P04" ratio="5 / 4" radius={10} src={ASSETS.mealHero} label="餐食配图" className="me-stat__asset" />
          <div className="me-stat__body">
            <span className="me-stat__label">已记录餐食</span>
            <span className="me-stat__value">
              {realStats?.mealRecords ?? fallbackStats?.meals ?? '—'}
              <small>{realStats?.mealRecords !== undefined || fallbackStats?.meals !== undefined ? '餐' : ''}</small>
            </span>
          </div>
        </div>
        <div className="me-stat">
          <AssetSlot id="P05" ratio="5 / 4" radius={10} src={ASSETS.mealSquare} label="茶饮配图" className="me-stat__asset" />
          <div className="me-stat__body">
            <span className="me-stat__label">已完成回顾</span>
            <span className="me-stat__value">
              {realStats?.reviewDays ?? fallbackStats?.reviews ?? '—'}
              <small>{realStats?.reviewDays !== undefined || fallbackStats?.reviews !== undefined ? '天' : ''}</small>
            </span>
          </div>
        </div>
      </section>

      <nav className="me-menu" aria-label="功能入口">
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.key}
            className="me-menu__row"
            disabled={!entry.ready}
            onClick={entry.onClick}
          >
            <Icon name={entry.icon} size={22} className="me-menu__icon" />
            <span className="me-menu__label">{entry.label}</span>
            {entry.ready ? (
              <Icon name="chevron" size={16} className="me-menu__arrow" />
            ) : (
              <span className="me-menu__soon">即将开放</span>
            )}
          </button>
        ))}
      </nav>

      <nav className="me-menu" aria-label="设置">
        <button type="button" className="me-menu__row" onClick={onOpenPrefs}>
          <Icon name="bell" size={22} className="me-menu__icon" />
          <span className="me-menu__label">提醒与偏好</span>
          <Icon name="chevron" size={16} className="me-menu__arrow" />
        </button>
        <button type="button" className="me-menu__row" onClick={onOpenPrivacy}>
          <Icon name="shield" size={22} className="me-menu__icon" />
          <span className="me-menu__label">隐私与授权</span>
          <Icon name="chevron" size={16} className="me-menu__arrow" />
        </button>
        <button type="button" className="me-menu__row" onClick={onOpenConsents}>
          <Icon name="shield" size={22} className="me-menu__icon" />
          <span className="me-menu__label">授权管理</span>
          <Icon name="chevron" size={16} className="me-menu__arrow" />
        </button>
      </nav>

      {profilePending && (
        <button type="button" className="btn btn-primary" onClick={onStartOnboarding}>
          {me?.status === 'data_pending' ? '去补充核对资料' : '继续完善资料'}
        </button>
      )}

      <button type="button" className="btn btn-ghost" onClick={() => void onLogout()}>
        退出登录
      </button>

      <p className="nurture-footer">食养融入日常，健康关怀更早一点。</p>
      <div className="footer-space" />
    </div>
  );
}
