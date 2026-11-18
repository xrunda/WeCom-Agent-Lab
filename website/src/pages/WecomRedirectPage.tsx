import { useEffect } from 'react';

import { Icon } from '../components/Icons';
import { WECOM_CONTACT_URL } from '../site';

/** 旧入口 /demo 保留：直接跳到已绑定的企微获客链接，不再出现中间页。 */
export function WecomRedirectPage() {
  useEffect(() => {
    document.title = '预约演示 · 知伴健康';
    window.location.replace(WECOM_CONTACT_URL);
  }, []);

  return (
    <main className="redirect-page">
      <div className="container redirect-page__inner">
        <p className="eyebrow">预约演示</p>
        <h1>正在打开企业微信…</h1>
        <p className="lede">如果没有自动跳转，可以点击下面的按钮直接联系顾问。</p>
        <a
          className="btn btn--primary"
          href={WECOM_CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          打开企业微信，联系顾问
          <Icon name="arrow" size={15} />
        </a>
      </div>
    </main>
  );
}
