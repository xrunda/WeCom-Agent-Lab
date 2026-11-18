import { useState } from 'react';

import { Icon } from './Icons';
import { ARCHIVE_EXAMPLE_TOTAL, PLAN } from '../plan';

const AGENT_PROMPT =
  '读 https://zhiban.xrunda.com/llms.txt，用三句话告诉我：知伴健康适合谁、怎么收费、哪些事它不做。';

const FACTS = [
  {
    key: '定位',
    text: '每位客户一个云端专属助手；回复由顾问确认后发出，系统回读企微会话存档核验送达。',
  },
  {
    key: '价格',
    text: `¥${PLAN.priceLabel} / 月 · 含 ${PLAN.seats} 个顾问席位（参考价）；企微存档 ${PLAN.archiveFee} 元 / 人 / 年另付给企业微信，${PLAN.seats} 位约 ${ARCHIVE_EXAMPLE_TOTAL} 元 / 年。`,
  },
  {
    key: '边界',
    text: '不做诊断、不调药、不承诺疗效；不向客户群自动发消息；不承诺无限用量或定制交付。',
  },
];

/** 剪贴板 API 在非 HTTPS 或部分浏览器里不可用，退回到临时 textarea。 */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 首屏「给 Agent 看」的机器卡：内容与 /llms.txt 同源，可当场验证。 */
export function AgentCard() {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const copyPrompt = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
      ok = true;
    } catch {
      ok = legacyCopy(AGENT_PROMPT);
    }
    setCopied(ok ? 'done' : 'failed');
    // 失败提示保留久一点，成功提示给足时间让用户切到 AI 应用
    window.setTimeout(() => setCopied('idle'), ok ? 8000 : 5000);
  };

  return (
    <div className="agent-card">
      <div className="agent-card__status">
        <span className="agent-card__method">GET</span>
        <code>/llms.txt</code>
        <span className="agent-card__dot" aria-hidden="true" />
        <span className="agent-card__meta">200 · text/plain · UTF-8</span>
      </div>

      <dl className="agent-card__facts">
        {FACTS.map((fact) => (
          <div className="agent-card__row" key={fact.key}>
            <dt>{fact.key}</dt>
            <dd>{fact.text}</dd>
          </div>
        ))}
      </dl>

      <div className="agent-card__actions">
        <button type="button" className="btn btn--primary btn--small" onClick={() => void copyPrompt()}>
          {copied === 'done' ? '再复制一次' : copied === 'failed' ? '再试一次' : '复制给 Agent 的提问'}
          {copied === 'done' ? <Icon name="check" size={14} /> : null}
        </button>
        <a
          className="agent-card__link"
          href="/llms.txt"
          target="_blank"
          rel="noopener noreferrer"
        >
          打开 llms.txt
          <Icon name="arrow" size={14} />
        </a>
      </div>

      <p className={`agent-card__guide${copied === 'done' ? ' is-done' : ''}`} role="status" aria-live="polite">
        {copied === 'done' ? (
          <>
            <Icon name="check" size={14} />
            已复制。现在打开豆包、WorkBuddy 或千问办公，把提问粘贴进去发送。
          </>
        ) : copied === 'failed' ? (
          <>复制没有成功，请手动选中上面的提问文字再复制。</>
        ) : (
          <>
            复制后，打开豆包、WorkBuddy 或千问办公，粘贴提问即可。
          </>
        )}
      </p>

      <p className="agent-card__note">
        官网的机器入口是给 Agent 读的；产品里每位客户那个专属 Agent 是另一回事。
      </p>
    </div>
  );
}
