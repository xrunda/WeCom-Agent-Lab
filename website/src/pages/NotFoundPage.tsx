import { Link } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { usePageMeta } from '../components/usePageMeta';

export function NotFoundPage() {
  usePageMeta('/404');
  return (
    <main className="not-found">
      <div className="container not-found__inner">
        <p className="eyebrow">404</p>
        <h1>这个页面不存在。</h1>
        <p className="lede">地址可能写错了，或者页面已经移动。</p>
        <Link className="btn btn--primary" to="/">
          回到首页
          <Icon name="arrow" size={15} />
        </Link>
      </div>
    </main>
  );
}
