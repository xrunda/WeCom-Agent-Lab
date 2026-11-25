/**
 * 分步建档（H02，PRD §6；契约 api §4.3）。
 *
 * 五步：目标 → 作息 → 饮食偏好 → 过敏安全 → 既有指导。
 * - 「不清楚」是合法选择（allergy 允许 unknown）
 * - 已有资料先展示、可确认；确认走 POST /profile/confirm
 * - 关键缺失（未回答过敏）不阻断流程本身，但状态保持 profile_incomplete（A03）
 */
import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  confirmProfileEntries,
  fetchProfile,
  newIdempotencyKey,
  submitProfileAnswers,
  type ProfileEntryView,
  type ProfileFieldKey,
  type ProfileStatusView,
} from '../api.ts';

const STEPS = [
  { key: 'basics', title: '希望改善什么', hint: '可以多选，例如睡眠、饮食规律' },
  { key: 'routine', title: '通常的作息', hint: '大概时间就可以，不用精确' },
  { key: 'food', title: '饮食偏好', hint: '喜欢和回避的口味' },
  { key: 'safety', title: '过敏与禁忌', hint: '这一步很重要；不确定可以选「不清楚」' },
  { key: 'guidance', title: '接受过的专业指导', hint: '如门诊医生给过的饮食要求' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

const STEP_KIND: Record<StepKey, 'check' | 'time' | 'pair' | 'safety' | 'check'> = {
  basics: 'check',
  routine: 'time',
  food: 'pair',
  safety: 'safety',
  guidance: 'check',
};

const GOAL_OPTIONS = ['改善睡眠', '饮食规律', '控制体重', '肠胃舒服', '精力更好'];
const LIKE_OPTIONS = ['清淡', '蒸煮', '汤粥', '家常菜'];
const DISLIKE_OPTIONS = ['辛辣', '油腻', '过咸', '生冷'];

interface Props {
  onUnauthorized: () => void;
  onDone: (status: ProfileStatusView) => void;
}

export function OnboardingWizard({ onUnauthorized, onDone }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [existing, setExisting] = useState<ProfileEntryView[]>([]);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [goals, setGoals] = useState<string[]>([]);
  const [likes, setLikes] = useState<string[]>([]);
  const [dislikes, setDislikes] = useState<string[]>([]);
  const [breakfast, setBreakfast] = useState('');
  const [lunch, setLunch] = useState('');
  const [dinner, setDinner] = useState('');
  const [bedtime, setBedtime] = useState('');
  const [waketime, setWaketime] = useState('');
  const [allergyUnknown, setAllergyUnknown] = useState(false);
  const [allergyText, setAllergyText] = useState('');
  const [guidance, setGuidance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchProfile()
      .then((result) => {
        setExisting(result.items);
        setConfirmedIds(
          result.items.filter((item) => item.status === 'confirmed').map((item) => item.id),
        );
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
      });
  }, [onUnauthorized]);

  const step = STEPS[stepIndex]!;
  // 同一步骤的幂等键稳定（弱网重试不会重复写 revisions）；进入步骤时生成一次
  const [stepKey] = useState(() => `${step.key}_${newIdempotencyKey()}`);

  const refreshStatus = async (): Promise<ProfileStatusView> => {
    const result = await fetchProfile();
    setExisting(result.items);
    return result.status;
  };
  const progress = Math.round(((stepIndex + (submitting ? 1 : 0)) / STEPS.length) * 100);

  const relevantExisting = useMemo(
    () => {
      const fieldOf: Record<StepKey, ProfileFieldKey | null> = {
        basics: 'goal',
        routine: null,
        food: 'food_preference',
        safety: 'allergy',
        guidance: 'existing_guidance',
      };
      const field = fieldOf[step.key];
      return field ? existing.filter((item) => item.fieldKey === field) : [];
    },
    [existing, step.key],
  );

  const hasConfirmedExisting = (): boolean =>
    relevantExisting.some((item) => confirmedIds.includes(item.id));

  const canSubmit = (): boolean => {
    // 本步已有条目被勾选确认时，可以不新增内容直接继续
    if (hasConfirmedExisting()) return true;
    switch (STEP_KIND[step.key]) {
      case 'check':
        return step.key === 'basics' ? goals.length > 0 : guidance.trim().length > 0;
      case 'time':
        return Boolean(breakfast || lunch || dinner || bedtime || waketime);
      case 'pair':
        return likes.length > 0 || dislikes.length > 0;
      case 'safety':
        return allergyUnknown || allergyText.trim().length > 0;
    }
  };

  const buildAnswers = (): Record<string, Record<string, unknown>> => {
    switch (step.key) {
      case 'basics':
        return { goal: { items: goals } };
      case 'routine': {
        // 只提交有输入的组：空对象会把已存的三餐/作息覆盖成「已填但为空」
        const answers: Record<string, Record<string, unknown>> = {};
        const mealTimes = {
          ...(breakfast ? { breakfast } : {}),
          ...(lunch ? { lunch } : {}),
          ...(dinner ? { dinner } : {}),
        };
        if (Object.keys(mealTimes).length > 0) answers.meal_times = mealTimes;
        const sleepTime = {
          ...(bedtime ? { bedtime } : {}),
          ...(waketime ? { waketime } : {}),
        };
        if (Object.keys(sleepTime).length > 0) answers.sleep_time = sleepTime;
        return answers;
      }
      case 'food':
        return { food_preference: { likes, dislikes } };
      case 'safety':
        return {
          allergy: {
            unknown: allergyUnknown,
            items: allergyUnknown ? [] : allergyText.split(/[、,，\s]+/).filter(Boolean),
          },
        };
      case 'guidance':
        return {
          existing_guidance: {
            items: guidance.split(/[、,，\s]+/).filter(Boolean),
          },
        };
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const confirmed = confirmedIds.length > 0;
      if (confirmed) {
        await confirmProfileEntries(confirmedIds).catch(() => undefined);
      }
      const answers = buildAnswers();
      // 只勾选确认、没有新增内容：不再提交空答案（服务端会按「本步未提交任何字段」拒绝）
      if (Object.keys(answers).length === 0) {
        if (!confirmed) {
          setError('本步还没有填写内容');
          return;
        }
        const status = await refreshStatus();
        if (stepIndex === STEPS.length - 1) {
          onDone(status);
        } else {
          setStepIndex((index) => index + 1);
        }
        return;
      }
      const result = await submitProfileAnswers({
        step: step.key,
        answers,
        idempotencyKey: stepKey,
      });
      if (stepIndex === STEPS.length - 1) {
        onDone(result.status);
        return;
      }
      setStepIndex((index) => index + 1);
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.details?.[0];
        setError(
          detail?.issue
            ? `${err.message}（${detail.field ?? ''}：${detail.issue}）`
            : err.message,
        );
      } else {
        setError('网络异常，请稍后再试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="card">
        <div className="steps" aria-label={`第 ${stepIndex + 1} 步，共 ${STEPS.length} 步`}>
          {STEPS.map((item, index) => (
            <span key={item.key} className={index <= stepIndex ? 'done' : ''} />
          ))}
        </div>
        <h1>{step.title}</h1>
        <p className="muted">{step.hint}</p>
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      {relevantExisting.length > 0 && (
        <div className="card">
          <h2>已有资料</h2>
          <p className="muted">已记录的内容如下；正确请勾选确认，不对可继续填写你的版本。</p>
          {relevantExisting.map((entry) => (
            <label className="consent-item" key={entry.id} htmlFor={`confirm-${entry.id}`}>
              <div className="text">
                <b>{entry.valueText}</b>
                <span>
                  来源：
                  {entry.source === 'patient'
                    ? '你的自述'
                    : entry.source === 'professional'
                      ? '专业确认'
                      : entry.source === 'advisor'
                        ? '团队录入'
                        : 'AI 整理（待确认）'}
                </span>
              </div>
              <input
                id={`confirm-${entry.id}`}
                type="checkbox"
                role="switch"
                className="switch"
                checked={confirmedIds.includes(entry.id)}
                onChange={(event) => {
                  setConfirmedIds((ids) =>
                    event.target.checked
                      ? [...ids, entry.id]
                      : ids.filter((id) => id !== entry.id),
                  );
                }}
              />
            </label>
          ))}
        </div>
      )}

      <div className="card">
        {STEP_KIND[step.key] === 'check' && step.key === 'basics' && (
          <CheckGroup options={GOAL_OPTIONS} selected={goals} onToggle={setGoals} />
        )}
        {step.key === 'routine' && (
          <div>
            <div className="field">
              <label htmlFor="breakfast">早餐时间</label>
              <input
                id="breakfast"
                type="time"
                value={breakfast}
                onChange={(event) => setBreakfast(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="lunch">午餐时间</label>
              <input
                id="lunch"
                type="time"
                value={lunch}
                onChange={(event) => setLunch(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="dinner">晚餐时间</label>
              <input
                id="dinner"
                type="time"
                value={dinner}
                onChange={(event) => setDinner(event.target.value)}
              />
            </div>
            <div className="row">
              <div className="field grow">
                <label htmlFor="bedtime">通常入睡</label>
                <input
                  id="bedtime"
                  type="time"
                  value={bedtime}
                  onChange={(event) => setBedtime(event.target.value)}
                />
              </div>
              <div className="field grow">
                <label htmlFor="waketime">通常起床</label>
                <input
                  id="waketime"
                  type="time"
                  value={waketime}
                  onChange={(event) => setWaketime(event.target.value)}
                />
              </div>
            </div>
          </div>
        )}
        {step.key === 'food' && (
          <div>
            <p className="muted">喜欢的口味</p>
            <CheckGroup options={LIKE_OPTIONS} selected={likes} onToggle={setLikes} />
            <p className="muted">回避的口味</p>
            <CheckGroup options={DISLIKE_OPTIONS} selected={dislikes} onToggle={setDislikes} />
          </div>
        )}
        {step.key === 'safety' && (
          <div>
            <div className="field">
              <label htmlFor="allergy-text">过敏或需要避免的食物</label>
              <input
                id="allergy-text"
                value={allergyText}
                onChange={(event) => setAllergyText(event.target.value)}
                placeholder="例如：海鲜、花生（用顿号分隔）"
                disabled={allergyUnknown}
              />
            </div>
            <label className="consent-item" htmlFor="allergy-unknown">
              <div className="text">
                <b>不清楚自己有没有过敏</b>
                <span>选择后团队会在后续帮你补充确认</span>
              </div>
              <input
                id="allergy-unknown"
                type="checkbox"
                role="switch"
                className="switch"
                checked={allergyUnknown}
                onChange={(event) => setAllergyUnknown(event.target.checked)}
              />
            </label>
          </div>
        )}
        {step.key === 'guidance' && (
          <div className="field">
            <label htmlFor="guidance-input">接受过的专业指导</label>
            <textarea
              id="guidance-input"
              rows={3}
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder="例如：低盐饮食、控制嘌呤（门诊医生给过的要求）"
            />
            <p className="muted">
              你填写的内容会记录为「你的自述」，不会被当作医生的结论。
            </p>
          </div>
        )}
      </div>

      <div className="row">
        {stepIndex > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setStepIndex((index) => index - 1)}
          >
            上一步
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary grow"
          disabled={!canSubmit() || submitting}
          onClick={() => void submit()}
        >
          {submitting ? '正在保存…' : stepIndex === STEPS.length - 1 ? '完成建档' : '下一步'}
        </button>
      </div>
      <p className="muted" style={{ textAlign: 'center' }}>
        已完成约 {progress}%
      </p>
    </div>
  );
}

function CheckGroup({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (next: string[]) => void;
}) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            className={`btn btn-inline ${active ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={active}
            onClick={() =>
              onToggle(
                active ? selected.filter((item) => item !== option) : [...selected, option],
              )
            }
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
