import { Icon } from '../components/Icons';
import { DemoForm } from '../components/DemoForm';
import { usePageMeta } from '../components/usePageMeta';

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
          <section className="demo-form-card" aria-labelledby="form-title">
            <h2 id="form-title">预约演示</h2>
            <p className="demo-form-card__hint">我们会通过您留下的联系方式沟通演示时间。</p>
            <DemoForm />
          </section>
        </div>
      </section>
    </main>
  );
}
