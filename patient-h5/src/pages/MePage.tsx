/**
 * 「我的」页（PH5-03 扩展）：状态 + 建档入口 + 授权/隐私入口 + 登出。
 */
import { useEffect, useRef } from 'react';

import type { MeResponse } from '../api.ts';

const STATUS_TEXT: Record<string, string> = {
  profile_incomplete: '资料待完善',
  data_pending: '资料待补充',
  plan_generating: '正在为你准备计划',
  plan_active: '计划执行中',
  plan_suspended: '计划已暂停',
  service_paused: '服务已暂停',
};

interface Props {
  me: MeResponse | null;
  onLogout: () => void;
  onStartOnboarding: () => void;
  onOpenConsents: () => void;
  onOpenPrivacy: () => void;
  onChanged: () => void;
}

export function MePage({
  me,
  onLogout,
  onStartOnboarding,
  onOpenConsents,
  onOpenPrivacy,
  onChanged,
}: Props) {
  // 只在挂载时刷新一次；依赖 onChanged 会因父组件重渲染不断触发（曾造成 /me 无限轮询）
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => {
    onChangedRef.current();
  }, []);

  const statusText = me ? (STATUS_TEXT[me.status] ?? me.status) : '…';
  const profilePending = me?.status === 'profile_incomplete' || me?.status === 'data_pending';

  return (
    <div className="page">
      <div className="brand" style={{ padding: '18px 0 6px' }}>
        <div className="logo-mark" aria-hidden="true" />
        <h1 style={{ fontSize: 20, margin: 0 }}>我的</h1>
      </div>

      <div className="card">
        <div className="status-line">
          <span className="label">当前状态</span>
          <span>{statusText}</span>
        </div>
        <div className="status-line">
          <span className="label">提醒</span>
          <span>{me?.reminderEnabled ? '已开启' : '已关闭'}</span>
        </div>
        {profilePending && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={onStartOnboarding}
          >
            {me?.status === 'data_pending' ? '去补充核对资料' : '继续完善资料'}
          </button>
        )}
      </div>

      <div className="card">
        <h2>账号与隐私</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button type="button" className="btn btn-secondary btn-inline grow" onClick={onOpenConsents}>
            授权管理
          </button>
          <button type="button" className="btn btn-secondary btn-inline grow" onClick={onOpenPrivacy}>
            隐私申请
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void onLogout()}
        >
          退出登录
        </button>
        <p className="muted">退出后本机缓存会被清理，重新进入需重新验证。</p>
      </div>

      <div className="footer-space" />
    </div>
  );
}
