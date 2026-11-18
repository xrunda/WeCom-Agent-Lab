import { Link } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { VideoTeaser } from '../components/VideoTeaser';
import { Screenshot } from '../components/Screenshot';
import { usePageMeta } from '../components/usePageMeta';

const TIMELINE = [
  {
    title: '客户发了健康日志',
    text: '林女士在「示例健康服务群」里发来今天的早餐照片和一句说明。',
    image: '/assets/screens/timeline-log.png',
    caption: '微信场景示意',
    alt: '微信客户群里，林女士发来早餐照片和健康日志',
  },
  {
    title: '到了约定时间，顾问收到提醒',
    text: '10:00 是上次约好的回访时间，陈顾问在企业微信里收到跟进提醒。',
    image: '/assets/screens/timeline-reminder.png',
    caption: '企微界面示意 · 演示数据',
    alt: '企业微信 1:1 对话里，系统提醒陈顾问回访林女士',
  },
  {
    title: '顾问查记录，确认后回复',
    text: '陈顾问先查林女士上次的反馈和昨天的午餐照片，再确认回复内容。',
    image: '/assets/screens/timeline-record.png',
    caption: '产品界面 · 演示数据',
    alt: '机构后台的服务详情，展示林女士的反馈与处理经过',
  },
  {
    title: '负责人回看处理进度',
    text: '负责人打开机构后台，看见这件事由谁处理、处理到哪一步。',
    image: '/assets/screens/timeline-progress.png',
    caption: '产品界面 · 演示数据',
    alt: '机构后台工作台，展示需要跟进的服务与处理状态',
  },
];

const ROLES = [
  {
    to: '/customer-agent',
    label: '换个顾问，怎么接上',
    icon: 'book' as const,
    text: '客户记录、上次回复和下次回访放在一起。',
  },
  {
    to: '/advisor',
    label: '今天有哪些客户要跟进',
    icon: 'bell' as const,
    text: '到点提醒，企微里问一句就能查记录。',
  },
  {
    to: '/management',
    label: '负责人怎么知道做没做',
    icon: 'chart' as const,
    text: '谁负责、处理到哪一步，打开后台就能查。',
  },
];

export function HomePage() {
  usePageMeta('/');
  return (
    <main>
      <section className="hero">
        <div className="container hero__grid">
          <div className="hero__copy">
            <p className="eyebrow">知伴健康 · 私域健康服务</p>
            <h1>每位客户，<br />都有一位记得他、<br />会提醒顾问的<br />健康助手。</h1>
            <p className="lede">
              客户照常在微信群晒餐、发日志。知伴为每位客户建立一个专属助手，帮顾问接上之前的服务，到点提醒跟进，让负责人看得见服务进度。
            </p>
            <div className="actions">
              <Link className="btn btn--primary" to="/demo">
                预约演示
                <Icon name="arrow" size={16} />
              </Link>
              <a className="btn btn--ghost" href="#service-day">
                看一次完整跟进
              </a>
            </div>
            <ul className="hero__points" aria-label="三项核心能力">
              <li><Icon name="book" size={16} />专属助手</li>
              <li><Icon name="bell" size={16} />主动提醒</li>
              <li><Icon name="chat" size={16} />企微问答</li>
            </ul>
          </div>

          <div className="hero__media">
            <Screenshot
              src="/assets/screens/hero-reminder.png"
              alt="企业微信里，系统向陈顾问推送林女士的回访提醒"
              caption="企微界面示意 · 演示数据"
              className="shot--hero"
            />
            <div className="hero__inset">
              <img src="/assets/screens/console-record-crop.png" alt="林女士服务记录局部" loading="lazy" />
              <span>客户记录局部 · 演示数据</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--cream" id="service-day">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">示例的一天</p>
            <h2>跟着一位客户看一天</h2>
          </div>
          <div className="timeline">
            {TIMELINE.map((step, index) => (
              <article className="timeline__step" key={step.title}>
                <Screenshot
                  src={step.image}
                  alt={step.alt}
                  caption={step.caption}
                  className="shot--timeline"
                />
                <div className="timeline__text">
                  <span className="timeline__num">0{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">角色入口</p>
            <h2>看看您的团队怎么用</h2>
          </div>
          <div className="role-grid">
            {ROLES.map((role, index) => (
              <Link className="role-card" to={role.to} key={role.to}>
                <span className="role-card__icon"><Icon name={role.icon} size={26} /></span>
                <span className="role-card__index">0{index + 1}</span>
                <h3>{role.label}</h3>
                <p>{role.text}</p>
                <span className="role-card__more">进入<Icon name="arrow" size={15} /></span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--cream">
        <div className="container">
          <div className="section-head section-head--split">
            <div>
              <p className="eyebrow">业务场景</p>
              <h2>从一对一指导群开始</h2>
              <p className="lede">
                从第一天建档，到每天晒餐、发日志，再到顾问按时回访，看看知伴怎么接进您现有的服务。
              </p>
            </div>
            <div className="actions actions--tight">
              <Link className="btn btn--primary" to="/scenarios">
                查看业务场景
                <Icon name="arrow" size={15} />
              </Link>
              <Link className="btn btn--ghost" to="/scenarios#product-demo">
                播放产品演示
                <Icon name="play" size={14} />
              </Link>
            </div>
          </div>
          <div className="video-teaser">
            <VideoTeaser poster="/assets/video/poster.jpg" to="/scenarios#product-demo" />
          </div>
        </div>
      </section>

      <section className="section section--invite">
        <div className="container invite">
          <div>
            <p className="eyebrow">合作邀请</p>
            <h2>从一位顾问、一个客户群开始。</h2>
            <p className="lede">接入 1–2 周真实业务，双方一起观察、评价知伴在哪些环节帮得上忙。</p>
          </div>
          <Link className="btn btn--primary" to="/demo">
            预约演示
            <Icon name="arrow" size={15} />
          </Link>
        </div>
      </section>
    </main>
  );
}
