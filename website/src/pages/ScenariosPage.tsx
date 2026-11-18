import { Link } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { ProductVideo } from '../components/ProductVideo';
import { Screenshot } from '../components/Screenshot';
import { usePageMeta } from '../components/usePageMeta';

export function ScenariosPage() {
  usePageMeta('/scenarios');
  return (
    <main>
      <section className="hero hero--compact">
        <div className="container hero__grid">
          <div className="hero__copy">
            <p className="eyebrow">业务场景</p>
            <h1>一对一健康指导群，<br />每天的服务怎么<br />跟下来？</h1>
            <p className="lede">
              做长期健康服务，建档只是第一天。往后的三餐照片、健康日志和顾问反馈都在群里，真正花时间的是每天找资料、记住上次说到哪、按时把回访做下去。
            </p>
          </div>
          <Screenshot
            src="/assets/screens/hero-log.png"
            alt="微信客户群里，林女士发来早餐照片和健康日志"
            caption="微信场景示意"
            className="shot--hero"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container split">
          <div>
            <p className="eyebrow">第一步</p>
            <h2>开始服务</h2>
            <p className="lede">为客户建档，明确负责顾问，把服务群和跟进安排对应起来。</p>
          </div>
          <Screenshot
            src="/assets/screens/groups-row.png"
            alt="机构后台的服务群与顾问配置"
            caption="产品界面 · 演示数据"
          />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">第二步</p>
            <h2>持续记录</h2>
            <p className="lede">客户照常晒餐、写日志。需要回看时，顾问可以按客户查之前的记录。</p>
          </div>
          <div className="pair">
            <Screenshot
              src="/assets/screens/hero-log.png"
              alt="微信客户群里，林女士照常发早餐照片和健康日志"
              caption="微信场景示意"
            />
            <Screenshot
              src="/assets/screens/record-log-card.png"
              alt="机构后台按客户查看林女士的健康日志"
              caption="产品界面 · 演示数据"
            />
          </div>
        </div>
      </section>

      <section className="section section--cream">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">第三步</p>
            <h2>按时回访</h2>
            <p className="lede">到了约定时间，系统提醒顾问。顾问可以先查记录，再确认并回复。</p>
          </div>
          <div className="pair">
            <Screenshot
              src="/assets/screens/reminder-card.png"
              alt="企业微信里，系统向陈顾问推送林女士的回访提醒"
              caption="企微界面示意 · 演示数据"
            />
            <Screenshot
              src="/assets/screens/console-service-detail.png"
              alt="顾问处理林女士回访的服务详情"
              caption="产品界面 · 演示数据"
            />
          </div>
        </div>
      </section>

      <section className="section video-section" id="product-demo">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">产品演示</p>
            <h2>看一次完整的客户跟进</h2>
            <p className="lede">从客户发日志，到顾问确认回复，再到负责人回看进度。</p>
          </div>
          <ProductVideo
            src="/assets/video/product-demo.mp4"
            poster="/assets/video/poster.jpg"
            subtitles="/assets/video/subtitles.vtt"
            title="知伴健康产品演示"
          />
        </div>
      </section>

      <section className="section section--cream">
        <div className="container split split--reverse">
          <Screenshot
            src="/assets/screens/console-service-detail.png"
            alt="林女士的服务详情，展示处理经过与核验状态"
            caption="产品界面 · 演示数据"
          />
          <div>
            <p className="eyebrow">服务记录</p>
            <h2>回看服务</h2>
            <p className="lede">
              客户问上次是谁跟进的，或者顾问换班需要接手，都可以顺着服务记录查。
            </p>
            <div className="actions actions--top">
              <Link className="btn btn--primary" to="/demo">
                聊聊我们的服务场景
                <Icon name="arrow" size={15} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
