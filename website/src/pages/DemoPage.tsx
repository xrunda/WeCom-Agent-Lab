import { Icon } from '../components/Icons';
import { usePageMeta } from '../components/usePageMeta';

export const WECOM_CONTACT_URL = 'https://work.weixin.qq.com/ca/cawcded818a8d398cf';

const STEPS = [
  { title: '了解现有流程', text: '先聊聊贵机构现在怎么建档、打卡和回访。', icon: 'chat' as const },
  { title: '确定接入范围', text: '用演示数据走一遍，确认从哪一位顾问、哪一个客户群开始。', icon: 'users' as const },
  { title: '共同回顾使用情况', text: '接入 1–2 周真实业务，期间一起观察，结束后一起评价。', icon: 'chart' as const },
];

export function DemoPage() {
  usePageMeta('/demo');
  return (
    <main>
      <section className="hero hero--compact hero--demo">
        <div className="container">
          <p className="eyebrow">预约演示</p>
          <h1>先用一个客户群，<br />看看知伴能帮上<br />什么忙。</h1>
          <p className="lede lede--wide">
            先聊聊贵机构现在怎么建档、打卡和回访，再用演示数据走一遍。如果双方觉得适合，可以从一位顾问、一个客户群开始，接入 1–2 周真实业务。期间一起观察，结束后一起评价哪些环节有价值，再决定下一步怎么推进。
          </p>
        </div>
      </section>

      <section className="section section--demo">
        <div className="container demo-layout">
          <aside className="demo-steps">
            <h2>接下来会发生什么</h2>
            <ol>
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="demo-steps__icon"><Icon name={step.icon} size={20} /></span>
                  <div>
                    <span className="demo-steps__num">0{index + 1}</span>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </aside>

          <section className="contact-card" aria-labelledby="contact-title">
            <div className="contact-card__qr">
              <img
                src="/assets/brand/wecom-contact-qr.png"
                alt="知伴健康顾问的企业微信二维码"
                width={688}
                height={688}
              />
            </div>
            <div className="contact-card__body">
              <p className="eyebrow">直接联系</p>
              <h2 id="contact-title">添加顾问企业微信</h2>
              <p className="contact-card__text">
                扫码添加后，直接和顾问约演示时间。不用填写表单，也不留联系方式给第三方。
              </p>
              <a
                className="btn btn--primary"
                href={WECOM_CONTACT_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开企业微信，联系顾问
                <Icon name="arrow" size={15} />
              </a>
              <p className="contact-card__note">
                手机端点击按钮可直接打开企业微信；电脑端也可以用微信或企业微信扫码。
              </p>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
