/**
 * 今天首页（PH5-03 占位骨架；真实数据在 PH5-05 落地）。
 * 区块固定、缺数据显示占位（PRD §3 H03 / 展示结构稳定原则）。
 */
import type { MeResponse } from '../api.ts';

const STATUS_BLOCK: Record<string, { title: string; text: string }> = {
  plan_generating: {
    title: '正在为你准备计划',
    text: '资料已收到，团队正在准备你的健康计划；完成后这里会显示今天的行动。',
  },
  plan_active: { title: '今天', text: '今日行动将在计划发布后显示。' },
  plan_suspended: { title: '计划已暂停', text: '团队暂停了当前计划，如需了解请联系顾问。' },
  service_paused: { title: '服务已暂停', text: '当前服务暂停中，历史内容仍可查看。' },
  data_pending: {
    title: '资料待补充',
    text: '有需要核对的信息，补充完成后开始准备计划。',
  },
  profile_incomplete: {
    title: '先完成建档',
    text: '回答几个小问题，我们才能为你准备合适的计划。',
  },
};

export function TodayPage({
  me,
  onStartOnboarding,
  onOpenNurture,
}: {
  me: MeResponse | null;
  onStartOnboarding: () => void;
  onOpenNurture: () => void;
}) {
  const block = STATUS_BLOCK[me?.status ?? 'profile_incomplete'] ?? STATUS_BLOCK.profile_incomplete!;
  const greeting = greetingOf(new Date());

  return (
    <div className="page">
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          {greeting}
        </p>
        <h1 style={{ margin: '4px 0 8px' }}>{block.title}</h1>
        <p className="muted">{block.text}</p>
        {(me?.status === 'profile_incomplete' || me?.status === 'data_pending') && (
          <button type="button" className="btn btn-primary" onClick={onStartOnboarding}>
            {me?.status === 'data_pending' ? '去补充核对' : '开始建档'}
          </button>
        )}
      </div>

      <div className="card">
        <h2>今日进度</h2>
        <p className="muted">计划发布后，这里显示今天完成了几项行动。</p>
      </div>

      <div className="card">
        <h2>快捷记录</h2>
        <div className="row">
          <button type="button" className="btn btn-secondary btn-inline grow" disabled>
            记一餐
          </button>
          <button type="button" className="btn btn-secondary btn-inline grow" disabled>
            晚间回顾
          </button>
        </div>
        <p className="muted">记录功能随计划开放。</p>
      </div>

      <div className="card">
        <h2>相关食养</h2>
        <button type="button" className="btn btn-secondary btn-inline" onClick={onOpenNurture}>
          看看食养主张
        </button>
        <p className="muted">与你的计划相关的文章将出现在这里。</p>
      </div>

      <div className="card">
        <h2>你的团队</h2>
        <p className="muted">计划发布后，这里显示你的负责顾问与联系入口。</p>
      </div>

      <div className="footer-space" />
    </div>
  );
}

function greetingOf(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
