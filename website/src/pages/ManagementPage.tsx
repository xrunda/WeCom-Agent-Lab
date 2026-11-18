import { Link } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { Screenshot } from '../components/Screenshot';
import { usePageMeta } from '../components/usePageMeta';

export function ManagementPage() {
  usePageMeta('/management');
  return (
    <main>
      <section className="hero hero--compact">
        <div className="container hero__grid">
          <div className="hero__copy">
            <p className="eyebrow">机构管理</p>
            <h1>哪些客户还没跟进，<br />负责人打开后台<br />就能查。</h1>
            <p className="lede">
              把服务进度和处理记录放到同一个地方。平时看谁还需要跟进，遇到客户反馈时，能顺着记录查这件事是怎么处理的。
            </p>
          </div>
          <Screenshot
            src="/assets/screens/console-dashboard.png"
            alt="机构后台工作台，展示需要跟进的服务与处理状态"
            caption="产品界面 · 演示数据"
            className="shot--hero"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">眼下要处理的事</p>
            <h2>先看眼下要处理的事。</h2>
            <p className="lede">看看是哪位客户、谁负责、当前处理到哪一步。</p>
          </div>
          <Screenshot
            src="/assets/screens/console-todo-highlight.png"
            alt="机构后台待办列表，高亮客户、负责顾问与当前状态"
            caption="产品界面 · 演示数据"
            className="shot--wide"
          />
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">点开一件事</p>
            <h2>点开一件事，看处理经过。</h2>
            <p className="lede">
              从林女士的服务记录里，回看顾问怎么处理、系统查到了什么。
            </p>
          </div>
          <Screenshot
            src="/assets/screens/console-service-detail.png"
            alt="林女士的服务详情，展示处理经过与核验状态"
            caption="产品界面 · 演示数据"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container split split--reverse">
          <Screenshot
            src="/assets/screens/console-groups-advisors.png"
            alt="机构后台的服务群与顾问配置"
            caption="产品界面 · 演示数据"
          />
          <div>
            <p className="eyebrow">落到具体的人和群</p>
            <h2>把服务安排落到具体的人和群。</h2>
            <p className="lede">明确哪个顾问负责哪个群，团队调整或交接时就有记录可查。</p>
            <div className="actions actions--top">
              <Link className="btn btn--primary" to="/demo">
                预约演示
                <Icon name="arrow" size={15} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
