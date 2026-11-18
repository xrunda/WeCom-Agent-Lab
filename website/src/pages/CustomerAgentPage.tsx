import { Link } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { Screenshot } from '../components/Screenshot';
import { usePageMeta } from '../components/usePageMeta';

const RECORDS = [
  {
    title: '这个月的健康日志',
    image: '/assets/screens/record-log-card.png',
    alt: '林女士这个月的健康日志记录',
  },
  {
    title: '上次顾问的回复',
    image: '/assets/screens/record-reply-card.png',
    alt: '陈顾问上次给林女士的回复',
  },
  {
    title: '下一次回访安排',
    image: '/assets/screens/record-plan-card.png',
    alt: '林女士下一次回访安排',
  },
];

export function CustomerAgentPage() {
  usePageMeta('/customer-agent');
  return (
    <main>
      <section className="hero hero--compact">
        <div className="container hero__grid">
          <div className="hero__copy">
            <p className="eyebrow">客户专属助手</p>
            <h1>换了顾问，客户也不用<br />把情况再讲一遍。</h1>
            <p className="lede">
              知伴为每位客户在云端建立一个自己的助手，也就是「个人 Agent」。它把这个人的服务记录和跟进安排放在一起。下次有问题，顾问可以从上次的进度接着往下做。
            </p>
          </div>
          <Screenshot
            src="/assets/screens/console-patient-agent.png"
            alt="林女士的专属助手主页，展示档案、记忆和跟进安排"
            caption="产品界面 · 演示数据"
            className="shot--hero"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">围绕同一位客户</p>
            <h2>以前说过的事，接下来还能找到。</h2>
            <p className="lede">
              这个月的健康日志、上次顾问的回复、下一次回访安排，顾问都可以围绕同一位客户查看。
            </p>
          </div>
          <div className="record-grid">
            {RECORDS.map((item, index) => (
              <article className="record" key={item.title}>
                <span className="record__num">0{index + 1}</span>
                <Screenshot src={item.image} alt={item.alt} caption="产品界面 · 演示数据" />
                <h3>{item.title}</h3>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">顾问接手</p>
            <h2>顾问接手时，先问一句。</h2>
            <p className="lede">
              在企业微信里问「林女士上次反馈了什么？」，顾问可以先看已有记录，再决定这次怎么跟进。
            </p>
          </div>
          <Screenshot
            src="/assets/screens/qa-feedback-card.png"
            alt="陈顾问在企业微信里询问林女士上次的反馈，助手返回已有记录"
            caption="企微界面示意 · 演示数据"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container split split--reverse">
          <Screenshot
            src="/assets/screens/group-reply-card.png"
            alt="林女士在原来的微信客户群里继续沟通，回复由顾问发出"
            caption="微信场景示意"
          />
          <div>
            <p className="eyebrow">服务不搬家</p>
            <h2>客户继续在原来的群里沟通。</h2>
            <p className="lede">
              林女士照常发消息，回复由顾问本人发出。接入前会向客户说明并取得会话存档同意，下次回访，顾问可以接着上次的话题问。
            </p>
            <div className="actions actions--top">
              <Link className="btn btn--primary" to="/advisor">
                看顾问怎么用
                <Icon name="arrow" size={15} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
