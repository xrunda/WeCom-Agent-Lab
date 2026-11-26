/**
 * 专业团队（H10，契约 api §8），按设计稿 ui-10 还原。
 *
 * 首期不做实时问诊：留言进入团队队列，答复沿现有会话送达。
 * 页面不承诺唤起指定微信会话，也不把「已收到」显示成「已处理」。
 * 语音与附件按 PRD 隐藏（增强项，无后端）。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchTeam, fetchTeamRequests, submitTeamRequest } from '../api.ts';
import type { FollowupView, TeamInfo } from '../api.ts';
import { ASSETS } from '../assets.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon } from '../components/Icon.tsx';

const STATUS_TEXT: Record<string, { label: string; className: string }> = {
  pending: { label: '待接收', className: 'chip chip--pending' },
  claimed: { label: '跟进中', className: 'chip chip--done' },
  resolved: { label: '已处理', className: 'chip chip--done' },
};

const KIND_LABEL: Record<string, string> = {
  question: '留言',
  need_help: '需要帮助',
  plan_adjust: '计划调整',
  risk: '身体不适',
  profile_correction: '资料更正',
  record_flag: '记录疑问',
};

interface Props {
  onBack: () => void;
  onUnauthorized: () => void;
}

export function TeamPage({ onBack, onUnauthorized }: Props) {
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [requests, setRequests] = useState<FollowupView[]>([]);
  const [category, setCategory] = useState('plan');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    fetchTeam()
      .then(setTeam)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
      });
    fetchTeamRequests()
      .then((result) => setRequests(result.items))
      .catch(() => undefined);
  };

  useEffect(load, [onUnauthorized]);

  const submit = async (): Promise<void> => {
    if (!message.trim()) {
      setError('先写一下想问的问题');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitTeamRequest({ category, message: message.trim() });
      setNotice('已提交，团队看到会尽快跟进；答复按服务时间安排。');
      setMessage('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const hasRisk = requests.some((item) => item.kind === 'risk' && item.status !== 'resolved');

  return (
    <div className="page page-team">
      <button type="button" className="link-btn plan-back" onClick={onBack} aria-label="返回">
        <span aria-hidden="true">‹</span> 我的专业团队
      </button>

      <header className="team-head">
        <h1>有人，与你一起照顾健康</h1>
        <p className="muted">日常问题与计划反馈，都可以告诉我们。</p>
      </header>

      {team && (
        <>
          <section className="team-advisor">
            <div className="team-advisor__body">
              <AssetSlot id="A03" ratio="1 / 1" radius={999} src={ASSETS.avatar} label="顾问头像" className="team-advisor__avatar" />
              <div>
                <p className="team-advisor__role">健康顾问</p>
                <p className="team-advisor__name">{team.advisorName}</p>
                <span className="tag-pill tag-pill--warm">日常服务协调</span>
              </div>
            </div>
            <AssetSlot id="P02" ratio="4 / 3" radius={0} src={ASSETS.mealHero} label="顾问配图" className="team-advisor__asset" />
          </section>

          <section className="team-group">
            <div className="team-group__avatars" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="team-group__body">
              <p className="team-group__name">
                营养指导团队
                <span className="team-group__badge">示例团队</span>
              </p>
              <p className="muted">食养计划与饮食指导</p>
            </div>
            <Icon name="chevron" size={16} className="team-group__arrow" />
          </section>
          <p className="team-hours">服务时间：{team.serviceHours}</p>
        </>
      )}

      {hasRisk && (
        <div className="notice notice-error" role="alert">
          如有紧急身体不适，请及时就医，不要等待留言回复。
        </div>
      )}

      <section className="team-form">
        <h2>
          这次想聊些什么？
          <span className="team-form__accent" aria-hidden="true" />
        </h2>
        <div className="team-cats">
          {(team?.categories ?? []).map((item) => {
            const active = category === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`team-cat ${active ? 'active' : ''}`}
                aria-pressed={active}
                onClick={() => setCategory(item.key)}
              >
                {item.label}
                {active && <Icon name="check" size={16} className="team-cat__check" />}
              </button>
            );
          })}
        </div>

        <div className="team-input">
          <textarea
            rows={3}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="说说你遇到的情况…"
            aria-label="说说你遇到的情况"
          />
        </div>

        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice notice-ok" role="status">
            {notice}
          </div>
        )}

        <div className="team-note">
          <Icon name="leaf" size={22} className="team-note__icon" />
          <div>
            <p className="team-note__title">关于回复</p>
            <p className="muted">留言将交由服务团队跟进，具体回复以团队服务安排为准。</p>
          </div>
        </div>

        <button type="button" className="btn btn-primary team-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在提交…' : '提交给专业团队'}
        </button>
        <button type="button" className="btn btn-secondary team-back" onClick={onBack}>
          返回微信联系顾问
        </button>
        <p className="team-disclaimer">如有紧急身体不适，请及时就医。</p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>我的留言</h2>
        </div>
        <ul className="followup-list">
          {requests.length === 0 && <li className="muted">还没有提交过留言。</li>}
          {requests.map((item) => {
            const status = STATUS_TEXT[item.status] ?? { label: item.status, className: 'chip' };
            return (
              <li className="followup-item" key={item.id}>
                <div className="followup-item__head">
                  <span className={status.className}>{status.label}</span>
                  <span className="muted">{KIND_LABEL[item.kind] ?? item.kind}</span>
                  <span className="muted followup-item__time">
                    {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <p className="followup-item__message">{item.message}</p>
                {item.status !== 'resolved' && (
                  <p className="muted">答复会通过服务会话送达，请在微信里查看。</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="footer-space" />
    </div>
  );
}
