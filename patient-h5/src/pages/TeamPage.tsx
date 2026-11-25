/**
 * 专业团队（H10，契约 api §8）。
 *
 * 首期不做实时问诊：提交后进入团队队列，答复沿现有会话人工送达。
 * 页面不承诺唤起指定微信会话，也不把「已收到」显示成「已处理」。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchTeam, fetchTeamRequests, submitTeamRequest } from '../api.ts';
import type { FollowupView, TeamInfo } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';

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
      <button type="button" className="link-btn plan-back" onClick={onBack}>
        ‹ 返回
      </button>

      <header className="team-head">
        <h1>我的专业团队</h1>
        <p className="muted">日常问题与计划反馈，都可以告诉我们。</p>
      </header>

      {team && (
        <section className="card team-info">
          <div className="team-info__row">
            <AssetSlot id="A03" ratio="1 / 1" radius={999} label="顾问头像" className="team-info__avatar" />
            <div>
              <p className="team-info__name">{team.advisorName}</p>
              <p className="muted">健康顾问 · 日常服务协调</p>
            </div>
          </div>
          {team.members.map((member) => (
            <div className="team-info__member" key={member.name}>
              <span>{member.name}</span>
              <span className="muted">{member.role}</span>
            </div>
          ))}
          <p className="muted">服务时间：{team.serviceHours}</p>
        </section>
      )}

      {hasRisk && (
        <div className="notice notice-error" role="alert">
          如有紧急身体不适，请及时就医，不要等待留言回复。
        </div>
      )}

      <section className="card">
        <h2>这次想聊些什么</h2>
        <div className="sheet__row">
          {(team?.categories ?? []).map((item) => (
            <button
              key={item.key}
              type="button"
              className={`btn btn-inline ${category === item.key ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={category === item.key}
              onClick={() => setCategory(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="team-message">说说你遇到的情况</label>
          <textarea
            id="team-message"
            rows={3}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="不需要填很详细，说清大概情况就行"
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
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在提交…' : '提交给专业团队'}
        </button>
        <p className="muted">留言会进入团队待办；「已收到」只是系统回执，有人接手后会显示「跟进中」。</p>
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
                  <p className="muted">
                    答复会通过服务会话送达，请在微信里查看。
                  </p>
                )}
                {item.status === 'resolved' && item.claimedAt && (
                  <p className="muted">已由团队处理。</p>
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
