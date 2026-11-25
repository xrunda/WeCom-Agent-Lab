/**
 * 食养栏目（PH5-03）：主张页（H01）+ 分类占位（H08 由 PH5-08 落地）。
 * 经典引用 / 白话解释 / 自拟文案在数据结构上区分并分别标注（A09）。
 */
import { useEffect, useState } from 'react';

import { ApiError, fetchManifesto, reportEvent } from '../api.ts';
import type { Manifesto } from '../api.ts';

const KIND_LABEL: Record<string, string> = {
  classic_quote: '经典原文',
  plain_explanation: '白话解释',
  brand_copy: '服务主张',
};

const CATEGORIES = [
  { key: 'classics_life', label: '经典与生活' },
  { key: 'ingredients', label: '认识食材' },
  { key: 'seasonal_living', label: '四时起居' },
];

interface Props {
  /** 首次引导模式：显示主按钮与跳过（H01） */
  intro?: boolean;
  onStart?: () => void;
  onSkip?: () => void;
  onUnauthorized?: () => void;
}

export function NurturePage({ intro, onStart, onSkip, onUnauthorized }: Props) {
  const [manifesto, setManifesto] = useState<Manifesto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchManifesto()
      .then(setManifesto)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401 && onUnauthorized) onUnauthorized();
        else setError(err instanceof Error ? err.message : '加载失败');
      });
  }, [onUnauthorized]);

  if (error) {
    return (
      <div className="page">
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <h1 style={{ textAlign: 'center', fontSize: 22 }}>知伴健康</h1>
        {manifesto?.slogans?.length ? (
          <div className="brand" style={{ padding: '10px 0 14px' }}>
            <div className="slogans" aria-label="服务主张">
              {manifesto.slogans.map((slogan) => (
                <span key={slogan}>{slogan}</span>
              ))}
            </div>
          </div>
        ) : null}
        {manifesto === null ? (
          <p className="muted" style={{ textAlign: 'center' }}>
            正在加载…
          </p>
        ) : (
          manifesto.sections.map((section, index) => (
            <div
              key={index}
              className={section.kind === 'classic_quote' ? 'classic-block' : 'plain-block'}
            >
              {section.kind === 'classic_quote' ? (
                <>
                  <blockquote className="classic">{section.text}</blockquote>
                  {section.citation && (
                    <p className="citation">出处：{section.citation}</p>
                  )}
                </>
              ) : (
                <p className={section.kind === 'brand_copy' ? 'brand-copy' : ''}>{section.text}</p>
              )}
              <span className="kind-tag">{KIND_LABEL[section.kind] ?? section.kind}</span>
            </div>
          ))
        )}
        {intro && (
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                void reportEvent('h5.session_start');
                onStart?.();
              }}
            >
              开始了解我的方案
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginTop: 8 }}
              onClick={onSkip}
            >
              先跳过，之后再看
            </button>
          </div>
        )}
      </div>

      {!intro && (
        <div className="card">
          <h2>食养阅读</h2>
          {CATEGORIES.map((category) => (
            <div className="status-line" key={category.key}>
              <span>{category.label}</span>
              <span className="muted">内容准备中</span>
            </div>
          ))}
          <p className="muted">
            文章栏目开放后将出现在这里；所有内容都经专业审核后发布。
          </p>
        </div>
      )}
    </div>
  );
}
