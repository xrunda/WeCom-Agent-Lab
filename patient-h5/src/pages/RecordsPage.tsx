/**
 * 记录历史（H09，契约 api §7.5）：按日查看，可展开更正说明。
 * 数字与列表都来自真实记录，无记录时明确显示空态。
 */
import { useEffect, useState } from 'react';

import {
  ApiError,
  fetchRecordHistory,
  type ArchiveMealView,
  type RecordHistoryItem,
} from '../api.ts';

const MEAL_LABEL: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const REVIEW_LABEL: Record<string, string> = {
  good: '不错',
  fair: '一般',
  tired: '有点累',
  uncomfortable: '不太舒服',
  calm: '平静',
  happy: '愉快',
  low: '低落',
  anxious: '烦躁',
  light: '睡得浅',
  poor: '没睡好',
  insomnia: '失眠',
};

function localDate(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function describe(item: RecordHistoryItem): string {
  if (item.kind === 'meal') {
    const content = item.content as {
      mealType?: string;
      confirmedFoods?: Array<{ name: string }>;
    };
    const foods = (content.confirmedFoods ?? []).map((entry) => entry.name).join('、');
    return `${MEAL_LABEL[content.mealType ?? ''] ?? '餐食'}：${foods || '（未填写食物）'}`;
  }
  if (item.kind === 'evening_review') {
    const content = item.content as Record<string, string | undefined>;
    const parts = ['overall', 'mood', 'sleep', 'bowel']
      .map((key) => content[key])
      .filter(Boolean)
      .map((value) => REVIEW_LABEL[value!] ?? value);
    return parts.length ? `回顾：${parts.join(' · ')}` : '回顾：未选择项目';
  }
  return '随手记';
}

interface Props {
  onBack: () => void;
  onUnauthorized: () => void;
}

export function RecordsPage({ onBack, onUnauthorized }: Props) {
  const [date, setDate] = useState(localDate());
  const [items, setItems] = useState<RecordHistoryItem[]>([]);
  const [archiveMeals, setArchiveMeals] = useState<ArchiveMealView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchRecordHistory(date)
      .then((result) => {
        setItems(result.items);
        setArchiveMeals(result.archiveMeals);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else {
          setItems([]);
          setArchiveMeals([]);
        }
      })
      .finally(() => setLoading(false));
  }, [date, onUnauthorized]);

  return (
    <div className="page">
      <button type="button" className="link-btn plan-back" onClick={onBack}>
        ‹ 返回
      </button>
      <header className="team-head">
        <h1>我的健康记录</h1>
        <p className="muted">按日期查看你记录过的内容；数字与这里一致。</p>
      </header>

      <div className="sheet__row" style={{ marginBottom: 12 }}>
        {[0, -1, -2].map((offset) => {
          const value = localDate(offset);
          return (
            <button
              key={value}
              type="button"
              className={`btn btn-inline ${date === value ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={date === value}
              onClick={() => setDate(value)}
            >
              {offset === 0 ? '今天' : offset === -1 ? '昨天' : '前天'}
            </button>
          );
        })}
      </div>

      {loading ? (
        <p className="muted">正在加载…</p>
      ) : items.length === 0 && archiveMeals.length === 0 ? (
        <div className="card">
          <p className="muted">这一天还没有记录。</p>
        </div>
      ) : (
        <ul className="followup-list">
          {items.map((item) => (
            <li className="followup-item" key={item.id}>
              <div className="followup-item__head">
                <span className="chip chip--done">
                  {item.kind === 'meal' ? '餐食' : item.kind === 'evening_review' ? '回顾' : '记录'}
                </span>
                <span className="muted followup-item__time">
                  {new Date(item.occurredAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="followup-item__message">{describe(item)}</p>
            </li>
          ))}
        </ul>
      )}

      {archiveMeals.length > 0 && (
        <section className="archive-meals" aria-label="服务群里的餐食">
          <h2 className="archive-meals__title">服务群里的记录</h2>
          <p className="muted archive-meals__hint">来自你在服务群里发的消息，团队也在看同一份。</p>
          <ul className="archive-meals__list">
            {archiveMeals.map((meal) => (
              <li className="archive-meal" key={meal.id}>
                {meal.hasPhoto && (
                  <img
                    className="archive-meal__photo"
                    src={`/zhiban/h5/records/history/archive/${encodeURIComponent(meal.id)}/photo`}
                    alt={`${MEAL_LABEL[meal.mealType] ?? '餐食'}照片`}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                <div className="archive-meal__body">
                  <p className="archive-meal__head">
                    <span className="chip chip--done">{MEAL_LABEL[meal.mealType] ?? '餐食'}</span>
                    <span className="muted archive-meal__time">
                      {new Date(meal.occurredAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </p>
                  <p className="archive-meal__foods">
                    {meal.foods.map((food) => food.name).join('、') || '（未识别出食物）'}
                  </p>
                  {meal.notes && <p className="muted archive-meal__notes">{meal.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted">如需更正，请在「专业团队」里留言说明，团队处理后这里会更新。</p>
      <div className="footer-space" />
    </div>
  );
}
