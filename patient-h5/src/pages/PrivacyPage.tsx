/**
 * 隐私页（PH5-02 #231，契约 api §3.3–§3.4）。
 * 查看授权摘要、留存口径、提交导出/纠错/删除申请（幂等提交）。
 */
import { useEffect, useState } from 'react';

import { ApiError, createPrivacyRequest, fetchPrivacySummary } from '../api.ts';
import type { PrivacySummary } from '../api.ts';

interface Props {
  onUnauthorized: () => void;
}

const KIND_LABEL: Record<string, string> = {
  export: '导出我的数据',
  correction: '申请更正',
  deletion: '申请删除',
};

const CONSENT_SCOPE_LABEL: Record<string, string> = {
  health_processing: 'AI 处理健康信息',
  team_access: '团队查看记录',
};

/** 内容指纹：同一份申请重试时复用幂等键（不含健康正文之外的语义） */
function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

const STATUS_LABEL: Record<string, { text: string; tag: string }> = {
  submitted: { text: '待处理', tag: 'tag tag-pending' },
  handled: { text: '已处理', tag: 'tag tag-done' },
  rejected: { text: '未通过', tag: 'tag' },
};

export function PrivacyPage({ onUnauthorized }: Props) {
  const [summary, setSummary] = useState<PrivacySummary | null>(null);
  const [detail, setDetail] = useState('');
  const [kind, setKind] = useState<'export' | 'correction' | 'deletion'>('export');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = (): void => {
    fetchPrivacySummary()
      .then(setSummary)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else setError(err instanceof Error ? err.message : '加载失败');
      });
  };

  useEffect(reload, [onUnauthorized]);

  const submit = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!detail.trim()) {
      setError('请填写申请说明');
      return;
    }
    setSubmitting(true);
    try {
      // 幂等键按「类型 + 内容」派生：弱网重试沿用同一个 key，服务端才能去重；
      // 内容改了才换 key（避免把不同申请并成一条）。
      const key = `prq_${kind}_${hashText(detail.trim())}`;
      await createPrivacyRequest({ kind, detail: detail.trim(), idempotencyKey: key });
      setNotice('申请已提交，团队处理后你会在服务会话收到回复。');
      setDetail('');
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="card">
        <h1>隐私与授权</h1>
        <div className="status-line">
          <span className="label">数据留存</span>
          <span>{summary?.retentionNotice ?? '—'}</span>
        </div>
        <div className="status-line">
          <span className="label">团队可见范围</span>
          <span>
            {summary
              ? summary.teamAccessScopes.length === 0
                ? '当前未向团队开放'
                : summary.teamAccessScopes
                    .map((scope) => CONSENT_SCOPE_LABEL[scope] ?? scope)
                    .join('、')
              : '—'}
          </span>
        </div>
        <p className="muted">
          撤回授权、更正、导出或删除都在这里发起；处理进度会显示在下方。
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
        <h2>提交申请</h2>
        <div className="field">
          <label htmlFor="privacy-kind">申请类型</label>
          <select
            id="privacy-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="export">导出我的数据</option>
            <option value="correction">申请更正</option>
            <option value="deletion">申请删除</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="privacy-detail">说明</label>
          <textarea
            id="privacy-detail"
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            rows={3}
            maxLength={300}
            placeholder="简单说明你要处理的内容（不需要填写健康信息）"
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? '正在提交…' : '提交申请'}
        </button>
        <p className="muted">同一内容重复提交不会产生重复记录。</p>
      </div>

      <div className="card">
        <h2>我的申请</h2>
        {(summary?.requests ?? []).length === 0 ? (
          <p className="muted">还没有提交过申请。</p>
        ) : (
          summary!.requests.map((request) => {
            const meta = STATUS_LABEL[request.status] ?? { text: request.status, tag: 'tag' };
            return (
              <div className="privacy-request-item" key={request.id}>
                <span className={meta.tag}>{meta.text}</span>
                {KIND_LABEL[request.kind] ?? request.kind}
                <span className="muted"> · {new Date(request.createdAt).toLocaleDateString('zh-CN')}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
