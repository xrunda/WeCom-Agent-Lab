/**
 * 我的健康计划（H04，契约 api §5.1），按设计稿 ui-09 还原：
 * 标题 + 已审核 → 大标语与周期 → 周进度 → 两项阶段卡 → 食养思路 →
 * 本周三件事 → 审核人 → 查看日历 → 调整入口。
 *
 * 周期由方案决定，页面上不写死 28 天。
 */
import { useEffect, useState } from 'react';

import { acknowledgePlan, ApiError, fetchCurrentPlan, submitPlanAdjust } from '../api.ts';
import type { PlanView } from '../api.ts';
import { ASSETS } from '../assets.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';
import { Icon } from '../components/Icon.tsx';

function dayCount(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00`).getTime();
  const end = new Date(`${endDate}T00:00:00`).getTime();
  return Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

function elapsedDays(startDate: string): number {
  const start = new Date(`${startDate}T00:00:00`).getTime();
  return Math.max(0, Math.floor((Date.now() - start) / (24 * 60 * 60 * 1000)));
}

interface Props {
  onBack: () => void;
  onAdjust: () => void;
  onOpenCalendar: () => void;
  onUnauthorized: () => void;
}

export function PlanPage({ onBack, onOpenCalendar, onUnauthorized }: Props) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<number | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustText, setAdjustText] = useState('');
  const [adjustSent, setAdjustSent] = useState(false);

  useEffect(() => {
    fetchCurrentPlan()
      .then((value) => {
        setPlan(value);
        setAcknowledged(value.acknowledgedAt);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else setError(err instanceof Error ? err.message : '加载失败');
      });
  }, [onUnauthorized]);

  const total = plan ? dayCount(plan.startDate, plan.endDate) : 0;
  const elapsed = plan ? Math.min(total, elapsedDays(plan.startDate) + 1) : 0;
  const week = plan ? Math.max(1, Math.ceil(elapsed / 7)) : 0;

  return (
    <div className="page page-plan">
      <button type="button" className="link-btn plan-back" onClick={onBack}>
        ‹ 返回
      </button>

      <header className="plan-head">
        <div className="plan-head__row">
          <h1>我的健康计划</h1>
          {plan?.review.reviewerName && (
            <span className="plan-badge">
              <Icon name="shield" size={15} />
              专业团队已审核
            </span>
          )}
        </div>
        <p className="plan-slogan">把健康，安排进生活。</p>
        {plan && (
          <>
            <p className="plan-period" aria-label={`食养陪伴周期 ${total} 天`}>
              你的 <b>{total}</b> 天食养陪伴
            </p>
            <p className="plan-meta-line">
              第 {plan.version} 版 · {plan.startDate.slice(5).replace('-', '/')} 起
            </p>
          </>
        )}
      </header>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      {plan && (
        <>
          <section className="plan-week">
            <div className="plan-week__row">
              <span className="plan-week__stage">
                第 {week} 周 · {plan.stageGoal}
              </span>
              <span className="plan-week__count">
                {elapsed} / {total} 天
              </span>
            </div>
            <div className="plan-week__bar" aria-hidden="true">
              <span style={{ width: `${Math.round((elapsed / total) * 100)}%` }} />
            </div>
          </section>

          <section className="plan-stages">
            {plan.focusPoints.slice(0, 2).map((point, index) => (
              <article className="plan-stage" key={point}>
                <div className="plan-stage__body">
                  <Icon name={index === 0 ? 'bowl' : 'moon'} size={22} />
                  <p className="plan-stage__title">{point}</p>
                  <p className="plan-stage__hint">
                    {index === 0 ? '三餐有节，营养更均衡。' : '规律作息，精神更充沛。'}
                  </p>
                </div>
                <AssetSlot
                  id={index === 0 ? 'P04' : 'P05'}
                  ratio="1 / 1"
                  radius={0}
                  src={index === 0 ? ASSETS.mealHero : ASSETS.mealSquare}
                  label="阶段配图"
                  className="plan-stage__asset"
                />
              </article>
            ))}
          </section>

          <section className="plan-reason">
            <h2>
              <span className="accent-bar" aria-hidden="true" />
              食养思路
            </h2>
            <blockquote className="plan-quote">“{plan.foodTherapyRationale}”</blockquote>
            <p className="plan-reason__text">{plan.rationale.basedOn.join('；')}</p>
            <button
              type="button"
              className="plan-reason__btn"
              onClick={() => setReasonOpen((open) => !open)}
            >
              为什么这样安排
              <Icon name="arrow" size={14} className={reasonOpen ? 'is-rotated' : ''} />
            </button>
            {reasonOpen && (
              <ul className="plan-reason__list">
                {plan.rationale.basedOn.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>
                <span className="accent-bar" aria-hidden="true" />
                本周，先做好{plan.actions.length}件事
              </h2>
            </div>
            <ol className="plan-actions">
              {plan.actions.map((action, index) => (
                <li className="plan-action" key={action.actionId}>
                  <span className="plan-action__index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="plan-action__body">
                    <span className="plan-action__title">{action.title}</span>
                    <span className="plan-action__method">{action.method}</span>
                  </span>
                  <AssetSlot
                    id="P07"
                    ratio="4 / 3"
                    radius={8}
                    src={index % 2 === 0 ? ASSETS.mealSquare : ASSETS.mealHero}
                    label="行动配图"
                    className="plan-action__asset"
                  />
                </li>
              ))}
            </ol>
          </section>

          <div className="plan-reviewer">
            <AssetSlot id="A01" ratio="1 / 1" radius={999} src={ASSETS.avatar} label="审核人头像" className="plan-reviewer__avatar" />
            <p>{plan.review.reviewerName ?? '专业团队'}与你一起回顾调整。</p>
          </div>
          {plan.review.reviewerName && (
            <p className="plan-sign">
              审核：{plan.review.reviewerName}
              {plan.review.reviewedAt
                ? ` · ${new Date(plan.review.reviewedAt).toLocaleDateString('zh-CN')}`
                : ''}
            </p>
          )}

          <button type="button" className="btn btn-primary plan-cta" onClick={onOpenCalendar}>
            查看我的健康日历
            <Icon name="chevron" size={16} />
          </button>

          <div className="plan-foot">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                if (acknowledged) return;
                void acknowledgePlan()
                  .then((result) => setAcknowledged(result.acknowledgedAt))
                  .catch(() => setAcknowledged(Date.now()));
              }}
              disabled={Boolean(acknowledged)}
            >
              {acknowledged ? '✓ 已了解计划' : '我已了解这份计划'}
            </button>
            <button type="button" className="link-btn" onClick={() => setAdjustOpen((open) => !open)}>
              {adjustSent ? '✓ 已提交，团队会联系你' : '计划不适合？告诉我们 ›'}
            </button>
          </div>

          {adjustOpen && !adjustSent && (
            <div className="card plan-adjust">
              <h2>告诉我们哪里不合适</h2>
              <textarea
                rows={3}
                value={adjustText}
                onChange={(event) => setAdjustText(event.target.value)}
                placeholder="例如：晚餐时间做不到 18:30"
                aria-label="调整说明"
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!adjustText.trim()}
                onClick={() => {
                  void submitPlanAdjust({ planVersion: plan.version, message: adjustText.trim() })
                    .then(() => setAdjustSent(true))
                    .catch(() => undefined);
                }}
              >
                提交给团队
              </button>
            </div>
          )}
        </>
      )}

      <div className="footer-space" />
    </div>
  );
}
