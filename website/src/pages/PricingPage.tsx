import { Icon } from '../components/Icons';
import { usePageMeta } from '../components/usePageMeta';
import { WECOM_CONTACT_URL } from '../site';

const INCLUDED = [
  {
    icon: 'book' as const,
    title: '客户专属助手',
    text: '为每位接入的客户建立专属助手，保留服务记录和跟进安排，顾问接手时能找到之前的情况。',
  },
  {
    icon: 'bell' as const,
    title: '主动跟进',
    text: '到了约定时间，系统主动提醒负责顾问。',
  },
  {
    icon: 'chat' as const,
    title: '企业微信顾问助手',
    text: '顾问可以用平常的话查客户反馈、找餐食照片，也可以让助手准备或修改回复草稿。顾问确认后亲自发送。',
  },
  {
    icon: 'chart' as const,
    title: '机构管理',
    text: '负责人可以配置客户群与顾问归属、查看待办和处理进度，并回看服务与核验记录。',
  },
];

const FAQ = [
  {
    q: '怎样算一位顾问？',
    a: '一位获得授权使用知伴的企业微信员工算一位顾问，含其负责的服务群和客户。控制台管理员账号不占顾问席位。',
  },
  {
    q: '客户需要换软件吗？',
    a: '客户继续在微信客户群与顾问沟通。接入群会话需完成告知与同意流程，顾问本人确认并发送客户回复。',
  },
  {
    q: '合作怎么开始？',
    a: '从一位顾问、一个客户群开始，接入 1–2 周真实业务，双方一起观察、评价系统在哪些环节帮得上忙。',
  },
];

function BookDemoLink({ className = 'btn btn--primary' }: { className?: string }) {
  return (
    <a className={className} href={WECOM_CONTACT_URL} target="_blank" rel="noopener noreferrer">
      预约演示
      <Icon name="arrow" size={15} />
    </a>
  );
}

export function PricingPage() {
  usePageMeta('/pricing');
  return (
    <main>
      <section className="hero hero--compact hero--pricing">
        <div className="container pricing-hero">
          <div className="pricing-hero__copy">
            <p className="eyebrow">产品定价</p>
            <h1>把平台服务费和<br />企微存档费算清楚。</h1>
            <p className="lede">
              知伴健康帮助机构在微信群里持续服务客户，让顾问按时跟进，让负责人看到服务进度。平台服务费与企业微信会话存档费分开列。
            </p>
          </div>

          <aside className="price-card" aria-labelledby="price-card-title">
            <p className="price-card__label">种子合作方案</p>
            <h2 className="price-card__title" id="price-card-title">
              <span className="price-card__amount">¥19,800</span>
              <span className="price-card__unit">/ 月</span>
            </h2>
            <p className="price-card__note">种子合作参考价，实际报价及服务范围以双方确认的方案为准。</p>
            <p className="price-card__scope">按 10 位顾问规划，控制台管理员账号不单独计费、不占顾问席位。</p>
            <div className="price-card__actions">
              <BookDemoLink />
              <a className="text-link text-link--dark" href="#included">
                查看方案包含什么
                <Icon name="arrow" size={14} />
              </a>
            </div>
          </aside>
        </div>
      </section>

      <section className="section section--cream" id="included">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">方案范围</p>
            <h2>方案包含什么</h2>
            <p className="lede">下面四项是当前产品里可以演示的能力，不涉及医疗效果、无限用量或定制交付。</p>
          </div>
          <ul className="plan-grid">
            {INCLUDED.map((item) => (
              <li className="plan-card" key={item.title}>
                <span className="plan-card__icon">
                  <Icon name={item.icon} size={22} />
                </span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section--soft">
        <div className="container archive-fee">
          <div className="archive-fee__copy">
            <p className="eyebrow">第三方费用</p>
            <h2>企微会话存档费，<br />单独向企业微信支付。</h2>
            <p className="lede">
              按需要开通存档的顾问人数计费，参考 900 元 / 人 / 年，实际以企业微信管理后台购买页为准。存档费单独支付。
            </p>
          </div>
          <div className="archive-fee__calc" aria-label="企微存档费示例">
            <p className="archive-fee__label">企微存档费示例</p>
            <p className="archive-fee__formula">10 位顾问 × 900 元 / 人 / 年</p>
            <p className="archive-fee__total">≈ 9,000 元 / 年</p>
            <p className="archive-fee__caption">示例金额 · 不含在平台服务费内</p>
          </div>
        </div>
      </section>

      <section className="section section--cream">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">常见问题</p>
            <h2>常见问题</h2>
          </div>
          <dl className="faq">
            {FAQ.map((item) => (
              <div className="faq__item" key={item.q}>
                <dt>{item.q}</dt>
                <dd>{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section section--invite">
        <div className="container invite">
          <div>
            <p className="eyebrow">合作邀请</p>
            <h2>先从一个客户群开始。</h2>
            <p className="lede">带上您现在的打卡、回访或顾问交接流程，我们一起看知伴能接在哪一步。</p>
          </div>
          <BookDemoLink />
        </div>
      </section>
    </main>
  );
}
