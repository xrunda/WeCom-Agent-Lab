import { Icon } from '../components/Icons';
import { usePageMeta } from '../components/usePageMeta';
import { WECOM_CONTACT_URL } from '../site';

interface CapabilityGroup {
  group: string;
  note: string;
  items: { name: string; text: string }[];
}

const CAPABILITIES: CapabilityGroup[] = [
  {
    group: '客户专属助手',
    note: '每位客户一个云端助手，记得这个人',
    items: [
      { name: '一人一个 Agent', text: '每位接入的客户独立建档，记忆、计划和服务记录互不混用。' },
      { name: '长期记忆', text: '过敏忌口、目标、作息、家庭情况等事实长期保留，每次回复自动带上。' },
      { name: '患者事实卡', text: '疾病、身高体重、用药、最近体征与最近饮食合成一张卡，建议前先核对。' },
      { name: '饮食记录', text: '客户晒餐时识别食物种类和大致份量，自动记一条饮食记录。' },
      { name: '慢病体征', text: '客户在对话里说出血压、血糖等数值时提取入档，可人工补录或修正。' },
      { name: '语音消息', text: '客户发语音时自动转写，后续检索、总结和回复都用文字。' },
      { name: '主动计划', text: '约定回访、提醒量血压这类安排落到具体时间，到点自动触发。' },
      { name: '对话时间线', text: '草稿、改稿、发送、核验全过程按时间留痕，顾问接手时能看回放。' },
    ],
  },
  {
    group: '顾问在企微里',
    note: '不切后台，用平常的话查和办',
    items: [
      { name: '自然语言查询', text: '问「林女士上次反馈了什么」就能拿到记录，不用记命令。' },
      { name: '待办聚合', text: '未完成草稿、到期承诺、告警、待回复会话，一次列清楚并带可处理入口。' },
      { name: '回复草稿', text: '按事实卡和上下文写成顾问口吻，短、具体、可直接转发到客户群。' },
      { name: '人工改稿', text: '回一句「语气软一点」，出第二版；改几次都以顾问的最终版为准。' },
      { name: '查餐食照片', text: '按客户、日期、餐次取回客户发的原图，附时间与餐次说明。' },
      { name: '企微侧边栏', text: '待回复、客户速览、草稿确认在一个侧边栏里，不离开当前群聊。' },
      { name: '顾问本人发送', text: '系统不代发客户群；每一句都经顾问确认后，以顾问身份发出。' },
    ],
  },
  {
    group: '质量与安全',
    note: '说出口之前，先把风险接住',
    items: [
      { name: '健康红线', text: '不诊断、不调药、不承诺疗效；急症只引导就医，并升级给主管。' },
      { name: '员工发言质检', text: '顾问自己打的字也进红线质检，命中后推送并留痕，可回看上下文。' },
      { name: '回读核验', text: '回读会话存档，确认「真的发了、发在对的群」，不只信点了按钮。' },
      { name: '错群告警', text: '发错群立即告警并指出目标群；连续错群暂停该顾问的自动推送。' },
      { name: '承诺追踪', text: '顾问答应客户的事进入追踪，到期提醒，超时催办，继续超时通知主管。' },
      { name: '全程留痕', text: '草稿各版本、实发正文、存档凭据、处理人，都可追溯。' },
    ],
  },
  {
    group: '机构管理',
    note: '负责人打开后台，看得见做没做',
    items: [
      { name: '团队关注', text: '未核验、发错群、队列阻塞、客户消息无人跟进，集中列出并给处理入口。' },
      { name: '实时服务流', text: '一条消息从生成草稿到核验完成的完整生命周期，可按群、顾问、状态筛。' },
      { name: '患者 Agent 主页', text: '记忆、主动计划、办事记录、对话时间线、饮食与慢病，一页看完。' },
      { name: '服务群与顾问', text: '开始服务时指定负责顾问和客户，团队调整或交接有记录可查。' },
      { name: '质检与告警', text: '风险草稿与员工发言红线集中处理，说明哪句话触发了哪条规则。' },
      { name: '知识库与话术', text: '机构自己的知识与话术维护在后台，顾问在企微里问到的就是这些原文。' },
      { name: '风险规则', text: '按机构红线配置关键词与处置方式，草稿发出前先过一遍。' },
      { name: '价值看板', text: '草稿采纳率、节省的顾问工时、人均服务客户数，用真实数据说话。' },
      { name: '服务记录导出', text: '按时间范围导出服务记录 PDF，含草稿正文、核验结果与操作人。' },
      { name: '体验中心', text: '机构自己走一遍提问、草稿、改稿、发送、核验的完整闭环。' },
      { name: '账号与登录', text: '企微扫码登录，账号密码带验证码；操作写入审计记录。' },
    ],
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
            <p className="price-card__scope">
              含 <strong>10 个顾问席位</strong>；控制台管理员账号不单独计费、不占顾问席位。
            </p>
            <p className="price-card__scope price-card__scope--note">
              使用客户群服务，还需为每位顾问单独购买企微会话存档（参考 900 元 / 人 / 年，付给企业微信）。
            </p>
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
            <h2>这个价格，包含下面这些能力。</h2>
            <p className="lede">
              平台服务费按月包干，不按账号数、不按调用量、不设增购价目。下面列出的都是当前产品里可以演示、可以验收的能力。
            </p>
          </div>

          <div className="capability-wrap">
            <table className="capability">
              <caption className="sr-only">种子合作方案包含的产品能力</caption>
              <thead>
                <tr>
                  <th scope="col" className="capability__check-col">已包含</th>
                  <th scope="col">能力</th>
                  <th scope="col">说明</th>
                </tr>
              </thead>
              {CAPABILITIES.map((group) => (
                <tbody key={group.group}>
                  <tr className="capability__group">
                    <th colSpan={3} scope="colgroup">
                      <span className="capability__group-name">{group.group}</span>
                      <span className="capability__group-note">{group.note}</span>
                    </th>
                  </tr>
                  {group.items.map((item) => (
                    <tr key={item.name}>
                      <td className="capability__check">
                        <span className="capability__mark" role="img" aria-label="包含">
                          <Icon name="check" size={15} />
                        </span>
                      </td>
                      <th scope="row">{item.name}</th>
                      <td>{item.text}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>

          <p className="capability-note">
            以上为产品现有能力，不含医疗效果承诺、定制开发、服务等级协议或无限用量。
          </p>
        </div>
      </section>

      <section className="section section--soft">
        <div className="container archive-fee">
          <div className="archive-fee__copy">
            <p className="eyebrow">第三方费用</p>
            <h2>企微会话存档费，<br />单独向企业微信支付。</h2>
            <p className="lede">
              知伴读取客户群消息、核验回复是否送达，依赖企业微信的会话存档能力。它由企业微信按开通存档的顾问人数收费，参考 900 元 / 人 / 年，直接付给企业微信，不含在平台服务费里。
            </p>
            <p className="archive-fee__must">
              没有开通存档的顾问，无法使用知伴的客户群服务；这笔费用需要先在企业微信管理后台购买，实际金额以购买页为准。
            </p>
          </div>
          <div className="archive-fee__calc" aria-label="10 位顾问的企微存档费">
            <p className="archive-fee__label">10 位顾问的企微存档费</p>
            <p className="archive-fee__formula">10 位顾问 × 900 元 / 人 / 年</p>
            <p className="archive-fee__total">≈ 9,000 元 / 年</p>
            <p className="archive-fee__caption">付给企业微信 · 不含在 19,800 元 / 月的平台服务费内</p>
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
