/**
 * 我的健康计划（H04，契约 api §5.1）。
 *
 * 只读已发布版本：阶段目标、起止、食养思路、本阶段重点、专业审核信息与版本。
 * 「已了解」只留痕，不替代专业审核；「计划不适合」提交调整申请。
 * 周期由方案决定，页面上不出现固定 28 天。
 */
import { useEffect, useState } from 'react';

import { acknowledgePlan, ApiError, fetchCurrentPlan, submitPlanAdjust } from '../api.ts';
import type { PlanView } from '../api.ts';
import { AssetSlot } from '../components/AssetSlot.tsx';

function formatDate(value: string): string {
  const [, month, day] = value.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

interface Props {
  onBack: () => void;
  onAdjust: () => void;
  onOpenCalendar: () => void;
  onUnauthorized: () => void;
}

export function PlanPage({ onBack, onAdjust, onOpenCalendar, onUnauthorized }: Props) {
  void onAdjust;
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<number | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustFormOpen, setAdjustFormOpen] = useState(false);
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

  return (
    <div className="page page-plan">
      <button type="button" className="link-btn plan-back" onClick={onBack}>
        ‹ 返回
      </button>

      <header className="plan-head">
        <div className="plan-head__row">
          <h1>我的健康计划</h1>
          {plan?.review.reviewerName && (
            <span className="plan-badge">专业团队已审核</span>
          )}
        </div>
        <p className="plan-slogan">把健康，安排进生活。</p>
        {plan && (
          <p className="plan-meta">
            第 {plan.version} 版 · {formatDate(plan.startDate)} 至 {formatDate(plan.endDate)}
          </p>
        )}
      </header>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      {plan && (
        <>
          <section className="plan-stages">
            {plan.focusPoints.slice(0, 2).map((point, index) => (
              <article className="plan-stage" key={point}>
                <AssetSlot
                  id={index === 0 ? 'P04' : 'P05'}
                  ratio="5 / 4"
                  radius={10}
                  label="阶段配图"
                  className="plan-stage__asset"
                />
                <p className="plan-stage__title">{point}</p>
              </article>
            ))}
          </section>

          <section className="plan-reason">
            <h2>食养思路</h2>
            <blockquote className="classic plan-quote">
              “{plan.foodTherapyRationale}”
            </blockquote>
            <button
              type="button"
              className="btn btn-secondary btn-inline"
              onClick={() => setAdjustOpen((open) => !open)}
            >
              为什么这样安排
            </button>
            {adjustOpen && (
              <ul className="plan-reason__list">
                {plan.rationale.basedOn.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>本阶段重点</h2>
            </div>
            <ol className="plan-actions">
              {plan.actions.map((action, index) => (
                <li className="plan-action" key={action.actionId}>
                  <span className="plan-action__index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="plan-action__body">
                    <span className="plan-action__title">{action.title}</span>
                    <span className="plan-action__method">{action.method}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div className="plan-reviewer">
            <AssetSlot id="A02" ratio="1 / 1" radius={999} label="审核人头像" className="plan-reviewer__avatar" />
            <p>专业团队与你一起回顾调整</p>
          </div>

          <button type="button" className="btn btn-primary" onClick={onOpenCalendar}>
            查看我的健康日历 ›
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
            <button
              type="button"
              className="link-btn"
              onClick={() => setAdjustFormOpen((open) => !open)}
            >
              {adjustSent ? '✓ 已提交，团队会联系你' : '计划不适合？告诉我们 ›'}
            </button>
          </div>

          {plan.review.reviewerName && (
            <p className="muted plan-sign">
              审核：{plan.review.reviewerName} ·{' '}
              {plan.review.reviewedAt ? new Date(plan.review.reviewedAt).toLocaleDateString('zh-CN') : '—'}
            </p>
          )}
        </>
      )}

      {adjustFormOpen && !adjustSent && plan && (
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
                .then(() => {
                  setAdjustSent(true);
                  setAdjustOpen(false);
                })
                .catch(() => setAdjustSent(false));
            }}
          >
            提交给团队
          </button>
        </div>
      )}

      <div className="footer-space" />
    </div>
  );
}
