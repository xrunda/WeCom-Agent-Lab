/**
 * 最小「我的」页（PH5-02）：状态 + 授权/隐私入口 + 登出。
 * PH5-03 建完整骨架后替换为四导航（今天/日历/食养/我的）。
 */
import { useEffect, useState } from 'react';

import { fetchMe } from '../api.ts';
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
  onLogout: () => void;
  onNavigate: (hash: string) => void;
}

export function MePage({ onLogout, onNavigate }: Props) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="page">
      <div className="brand" style={{ padding: '18px 0 6px' }}>
        <div className="logo-mark" aria-hidden="true" />
        <h1 style={{ fontSize: 20, margin: 0 }}>我的</h1>
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <div className="status-line">
          <span className="label">当前状态</span>
          <span>{me ? (STATUS_TEXT[me.status] ?? me.status) : '…'}</span>
        </div>
        <div className="status-line">
          <span className="label">提醒</span>
          <span>{me?.reminderEnabled ? '已开启' : '已关闭'}</span>
        </div>
        <p className="muted">完整功能（今天、日历、食养阅读）将在后续版本开放。</p>
      </div>

      <div className="card">
        <h2>账号与隐私</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="btn btn-secondary btn-inline grow"
            onClick={() => onNavigate('#/consents')}
          >
            授权管理
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-inline grow"
            onClick={() => onNavigate('#/privacy')}
          >
            隐私申请
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={loggingOut}
          onClick={() => {
            setLoggingOut(true);
            void onLogout();
          }}
        >
          {loggingOut ? '正在退出…' : '退出登录'}
        </button>
        <p className="muted">退出后本机缓存会被清理，重新进入需重新验证。</p>
      </div>

      <div className="footer-space" />
    </div>
  );
}
