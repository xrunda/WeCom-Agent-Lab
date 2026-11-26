/**
 * 授权页（PH5-02 #231，契约 api §3）。
 *
 * - 五项分项授权，逐项授予/撤回；说明来自服务端文案
 * - 撤回 service_basic 会同时退出登录（服务端撤销会话 + 清 Cookie）
 * - 与企微会话存档同意是两件事（页面文案说明，分别记录）
 */
import { useEffect, useState } from 'react';

import { PageBack } from '../components/PageBack.tsx';
import { ApiError, decideConsent, fetchConsents } from '../api.ts';
import type { ConsentItem } from '../api.ts';

interface Props {
  onUnauthorized: () => void;
  onDone?: () => void;
}

export function ConsentsPage({ onUnauthorized, onDone }: Props) {
  const [items, setItems] = useState<ConsentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);

  const reload = (): void => {
    fetchConsents()
      .then((result) => setItems(result.items))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else setError(err instanceof Error ? err.message : '加载授权信息失败');
      });
  };

  useEffect(reload, [onUnauthorized]);

  const toggle = async (item: ConsentItem): Promise<void> => {
    const action = item.status === 'granted' ? 'withdraw' : 'grant';
    setBusyScope(item.scope);
    setError(null);
    setNotice(null);
    try {
      await decideConsent({ scope: item.scope, action });
      if (item.scope === 'service_basic' && action === 'withdraw') {
        setNotice('已撤回「进入个人服务」，当前登录已退出。');
        onUnauthorized();
        return;
      }
      setNotice(
        action === 'grant' ? `已授权「${item.title}」。` : `已撤回「${item.title}」，相关服务将停止。`,
      );
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setBusyScope(null);
    }
  };

  return (
    <div className="page">
      {onDone && <PageBack onClick={onDone} />}
      <div className="card">
        <h1>服务与隐私授权</h1>
        <p className="muted">
          每一项授权都可以单独开启或关闭；关闭后对应服务停止，不影响其他项。
          本授权与企业微信会话存档同意是两件事，分别记录、互不影响。
        </p>
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

      <div className="card">
        {items === null ? (
          <p className="muted">正在加载…</p>
        ) : (
          items.map((item) => (
            <div className="consent-item" key={item.scope}>
              <div className="text">
                <b>{item.title}</b>
                <span>{item.summary}</span>
              </div>
              <input
                type="checkbox"
                className="switch"
                role="switch"
                aria-label={item.title}
                checked={item.status === 'granted'}
                disabled={busyScope === item.scope}
                onChange={() => void toggle(item)}
              />
            </div>
          ))
        )}
      </div>

      {onDone && (
        <button type="button" className="btn btn-primary" onClick={onDone}>
          继续
        </button>
      )}
    </div>
  );
}
