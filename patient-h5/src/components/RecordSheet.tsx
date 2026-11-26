/**
 * 记录面板（H06 餐食 / H07 晚间回顾）。
 *
 * 顺序与失败处理都按契约：先建文字记录，再传照片；照片失败只提示重试，
 * 已保存的记录不受影响。识别候选与患者确认分开，候选不清空。
 */
import { useRef, useState } from 'react';

import { Sheet } from './Sheet.tsx';

import {
  confirmRecordFoods,
  createEveningReview,
  createMealRecord,
  newIdempotencyKey,
  uploadRecordPhoto,
  type FoodCandidate,
  type MealType,
} from '../api.ts';

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const REVIEW_OPTIONS = {
  overall: [
    { key: 'good', label: '不错' },
    { key: 'fair', label: '一般' },
    { key: 'tired', label: '有点累' },
    { key: 'uncomfortable', label: '不太舒服' },
  ],
  mood: [
    { key: 'calm', label: '平静' },
    { key: 'happy', label: '愉快' },
    { key: 'low', label: '低落' },
    { key: 'anxious', label: '烦躁' },
  ],
  sleep: [
    { key: 'good', label: '睡得好' },
    { key: 'light', label: '睡得浅' },
    { key: 'poor', label: '没睡好' },
    { key: 'insomnia', label: '失眠' },
  ],
} as const;

interface Props {
  mode: 'meal' | 'review';
  defaultMealType: MealType;
  linkedCalendarItemId?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function RecordSheet({ mode, defaultMealType, linkedCalendarItemId, onClose, onSaved }: Props) {
  const [mealType, setMealType] = useState<MealType>(defaultMealType);
  const [foodText, setFoodText] = useState('');
  const [notes, setNotes] = useState('');
  const [review, setReview] = useState<Record<string, string>>({});
  const [discomfort, setDiscomfort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoState, setPhotoState] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<FoodCandidate[]>([]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const idKey = useRef(newIdempotencyKey());
  const fileRef = useRef<HTMLInputElement | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'meal') {
        const foods = foodText
          .split(/[、,，\s]+/)
          .filter(Boolean)
          .map((name) => ({ name }));
        const record = await createMealRecord({
          occurredAt: Date.now(),
          mealType,
          confirmedFoods: foods,
          ...(notes ? { patientNotes: notes } : {}),
          ...(linkedCalendarItemId ? { linkedCalendarItemId } : {}),
          idempotencyKey: idKey.current,
        });
        setRecordId(record.id);
        onSaved('已记录这一餐');
      } else {
        await createEveningReview({
          occurredAt: Date.now(),
          ...(review.overall ? { overall: review.overall } : {}),
          ...(review.mood ? { mood: review.mood } : {}),
          ...(review.sleep ? { sleep: review.sleep } : {}),
          ...(discomfort ? { discomfort } : {}),
          ...(notes ? { notes } : {}),
          idempotencyKey: idKey.current,
        });
        onSaved('已记录今天的感受');
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async (file: File): Promise<void> => {
    if (!recordId) {
      setPhotoState('请先保存文字记录，再上传照片');
      return;
    }
    setPhotoState('正在上传…');
    try {
      const result = await uploadRecordPhoto({ recordId, file });
      setCandidates(result.recognition.candidates);
      setPhotoState(
        result.recognition.status === 'skipped' || result.recognition.status === 'failed'
          ? '照片已保存；暂时识别不出菜品，可以自己填写'
          : `识别到 ${result.recognition.candidates.length} 个候选，请确认`,
      );
      if (result.recognition.candidates.length > 0) {
        await confirmRecordFoods(
          recordId,
          result.recognition.candidates.map((item) => ({ name: item.name })),
        );
      }
    } catch (err) {
      // 照片失败不影响已保存的记录
      setPhotoState(err instanceof Error ? `上传失败：${err.message}` : '上传失败，可重试');
    }
  };

  return (
    <Sheet open onClose={onClose} label={mode === 'meal' ? '记录这一餐' : '晚间回顾'}>
        <h2>{mode === 'meal' ? '记录这一餐' : '晚间回顾'}</h2>

        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}

        {mode === 'meal' ? (
          <>
            <div className="sheet__row">
              {(Object.keys(MEAL_LABELS) as MealType[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`btn btn-inline ${mealType === key ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={mealType === key}
                  onClick={() => setMealType(key)}
                >
                  {MEAL_LABELS[key]}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="foods">吃了什么（用顿号分隔）</label>
              <input
                id="foods"
                value={foodText}
                onChange={(event) => setFoodText(event.target.value)}
                placeholder="例如：米饭、清蒸鱼、西兰花"
              />
            </div>
            <div className="field">
              <label htmlFor="meal-notes">感受（可选）</label>
              <input
                id="meal-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="吃得怎么样"
              />
            </div>
            {recordId && (
              <div className="sheet__photo">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadPhoto(file);
                  }}
                />
                <button type="button" className="btn btn-secondary btn-inline" onClick={() => fileRef.current?.click()}>
                  拍张照片（可选）
                </button>
                {photoState && <p className="muted">{photoState}</p>}
                {candidates.length > 0 && (
                  <ul className="sheet__candidates">
                    {candidates.map((item) => (
                      <li key={item.name}>{item.name}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {(['overall', 'mood', 'sleep'] as const).map((group) => (
              <div key={group} className="sheet__group">
                <p className="muted">
                  {group === 'overall' ? '整体感受' : group === 'mood' ? '心情' : '昨晚睡眠'}
                </p>
                <div className="sheet__row">
                  {REVIEW_OPTIONS[group].map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`btn btn-inline ${review[group] === option.key ? 'btn-primary' : 'btn-secondary'}`}
                      aria-pressed={review[group] === option.key}
                      onClick={() =>
                        setReview((prev) => ({
                          ...prev,
                          [group]: prev[group] === option.key ? '' : option.key,
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="field">
              <label htmlFor="discomfort">有没有不舒服（可不填）</label>
              <input
                id="discomfort"
                value={discomfort}
                onChange={(event) => setDiscomfort(event.target.value)}
                placeholder="例如：晚饭后有点胀"
              />
            </div>
            <p className="muted">每一项都可以跳过；没填不代表没有异常。</p>
          </>
        )}

        <div className="sheet__actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '正在保存…' : '保存'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
    </Sheet>
  );
}
