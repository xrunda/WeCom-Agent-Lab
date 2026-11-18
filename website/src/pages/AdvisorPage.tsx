import { Link } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { Screenshot } from '../components/Screenshot';
import { usePageMeta } from '../components/usePageMeta';

export function AdvisorPage() {
  usePageMeta('/advisor');
  return (
    <main>
      <section className="hero hero--compact">
        <div className="container hero__grid">
          <div className="hero__copy">
            <p className="eyebrow">顾问工作台</p>
            <h1>系统主动提醒，<br />顾问也能在企微里<br />直接交代事情。</h1>
            <p className="lede">
              今天该跟进谁，知伴会按安排提醒。碰到客户问起以前的事，顾问可以在企业微信里直接问助手，把时间留给沟通和判断。
            </p>
          </div>
          <Screenshot
            src="/assets/screens/hero-reminder.png"
            alt="企业微信里，系统向陈顾问推送林女士的回访提醒"
            caption="企微界面示意 · 演示数据"
            className="shot--hero"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">到点提醒</p>
            <h2>到点主动提醒。</h2>
            <p className="lede">
              林女士约好今天回访。时间到了，顾问收到跟进提醒，可以先查她上次的反馈。
            </p>
          </div>
          <div className="pair">
            <Screenshot
              src="/assets/screens/console-care-plan.png"
              alt="林女士今天 10:00 的跟进安排"
              caption="产品界面 · 演示数据"
            />
            <Screenshot
              src="/assets/screens/reminder-card.png"
              alt="企业微信里，系统向陈顾问推送林女士的回访提醒"
              caption="企微界面示意 · 演示数据"
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">直接问助手</p>
            <h2>在企微里问一句。</h2>
            <p className="lede">不用切后台，顾问用自己的话问，助手返回已有记录。</p>
          </div>
          <div className="pair">
            <div className="qa-item">
              <p className="qa-question">林女士上次反馈了什么？</p>
              <Screenshot
                src="/assets/screens/qa-feedback-card.png"
                alt="企业微信问答：林女士上次反馈了什么，助手返回上次回复"
                caption="企微界面示意 · 演示数据"
              />
            </div>
            <div className="qa-item">
              <p className="qa-question">帮我找一下林女士昨天的午餐照片。</p>
              <Screenshot
                src="/assets/screens/qa-photo-card.png"
                alt="企业微信问答：助手返回林女士昨天的午餐照片和记录"
                caption="企微界面示意 · 演示数据"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="section section--cream">
        <div className="container split">
          <div>
            <p className="eyebrow">人负责判断</p>
            <h2>顾问确认，再发到客户群。</h2>
            <p className="lede">
              顾问核对原记录，需要时改一改回复，确认后发到对应客户群。
            </p>
            <div className="actions actions--top">
              <Link className="btn btn--primary" to="/management">
                看负责人怎么掌握进度
                <Icon name="arrow" size={15} />
              </Link>
            </div>
          </div>
          <Screenshot
            src="/assets/screens/console-service-detail.png"
            alt="机构后台的服务详情，展示回复草稿、发送与核验状态"
            caption="产品界面 · 演示数据"
          />
        </div>
      </section>
    </main>
  );
}
