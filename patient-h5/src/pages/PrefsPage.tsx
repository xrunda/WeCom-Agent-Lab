/**
 * 提醒偏好（H09，契约 api §10）。
 * 只能更严格：上限只能调小，安静时段只能变长；界面直接告诉患者这一点。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchReminderPrefs, updateReminderPrefs, type ReminderPrefs } from '../api.ts';

interface Props {
  onBack: () => void;
  onUnauthorized: () => void;
}

export function PrefsPage({ onBack, onUnauthorized }: Props) {
  const [prefs, setPrefs] = useState<ReminderPrefs | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchReminderPrefs()
      .then(setPrefs)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
      });
  }, [onUnauthorized]);

  const save = async (patch: Partial<ReminderPrefs>): Promise<void> => {
    setBusy(true);
    try {
      const next = await updateReminderPrefs(patch);
      setPrefs(next);
      setNotice('已保存');
    } catch {
      setNotice('保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <button type="button" className="link-btn plan-back" onClick={onBack}>
        ‹ 返回
      </button>
      <header className="team-head">
        <h1>提醒与偏好</h1>
        <p className="muted">提醒只在你允许的时段发；下面的限制只能更严，不能更松。</p>
      </header>

      {notice && (
        <div className="notice notice-ok" role="status">
          {notice}
        </div>
      )}

      {prefs && (
        <>
          <section className="card">
            <div className="consent-item">
              <div className="text">
                <b>接收提醒</b>
                <span>关闭后不再生成任何提醒，包括温和询问。</span>
              </div>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                aria-label="接收提醒"
                checked={prefs.enabled}
                disabled={busy}
                onChange={(event) => void save({ enabled: event.target.checked })}
              />
            </div>
            <div className="consent-item">
              <div className="text">
                <b>当日晚间温和询问</b>
                <span>当天没有记录时，晚上问一句；计入每日上限。</span>
              </div>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                aria-label="当日晚间温和询问"
                checked={prefs.gentleInquiry !== false}
                disabled={busy}
                onChange={(event) => void save({ gentleInquiry: event.target.checked })}
              />
            </div>
          </section>

          <section className="card">
            <h2>每日最多</h2>
            <div className="sheet__row">
              {[0, 1, 2].map((limit) => (
                <button
                  key={limit}
                  type="button"
                  className={`btn btn-inline ${prefs.dailyLimit === limit ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={prefs.dailyLimit === limit}
                  disabled={busy || limit > prefs.tenantDefaults.dailyLimit}
                  onClick={() => void save({ dailyLimit: limit })}
                >
                  {limit} 次
                </button>
              ))}
            </div>
            <p className="muted">机构上限是 {prefs.tenantDefaults.dailyLimit} 次，只能调低。</p>
          </section>

          <section className="card">
            <h2>安静时段</h2>
            <p className="muted">
              当前 {prefs.quietHours?.start ?? prefs.tenantDefaults.quietHours.start} –
              {prefs.quietHours?.end ?? prefs.tenantDefaults.quietHours.end}
              ；机构默认 {prefs.tenantDefaults.quietHours.start}–
              {prefs.tenantDefaults.quietHours.end}，只能更长。
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn-secondary btn-inline grow"
                disabled={busy}
                onClick={() => void save({ quietHours: { start: '20:00', end: '09:00' } })}
              >
                20:00 – 09:00
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-inline grow"
                disabled={busy}
                onClick={() => void save({ quietHours: prefs.tenantDefaults.quietHours })}
              >
                恢复默认
              </button>
            </div>
          </section>
        </>
      )}

      <div className="footer-space" />
    </div>
  );
}
