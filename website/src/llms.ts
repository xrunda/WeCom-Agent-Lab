import { ARCHIVE_EXAMPLE_TOTAL, PLAN } from './plan.ts';
import { NAV, PAGE_META, WECOM_CONTACT_URL } from './site.ts';

const CONSOLE_URL = '/console/';

function absolute(origin: string | undefined, path: string): string {
  if (!origin) return path;
  return new URL(path, origin.endsWith('/') ? origin : `${origin}/`).toString();
}

const CAPABILITIES = [
  '每位客户一个云端专属助手：独立的记忆、主动计划与服务记录；过敏忌口、目标、作息长期保留。',
  '顾问在企业微信里用自然语言查询：客户反馈、待办与告警、餐饮照片、知识库与话术原文。',
  '回复草稿按事实卡写成顾问口吻，可一句话改稿；每条回复由顾问本人确认后发出，系统不代发客户群。',
  '到点主动提醒顾问回访；承诺到期追踪，超时催办。',
  '健康红线前置校验（不诊断、不调药、不承诺疗效），员工发言同样质检。',
  '回读企业微信会话存档，确认回复真的发出、发在对的群；错群告警，连续错群暂停推送。',
  '机构后台：团队关注、实时服务流、患者 Agent 主页、服务群与顾问配置、质量告警、知识库与话术、价值看板、服务记录导出。',
];

const OUT_OF_SCOPE = [
  '不做诊断、不给用药剂量、不承诺疗效；急症只引导就医。',
  '系统不向客户群自动发送消息，每条由顾问确认后发出。',
  '不承诺医疗效果、无限用量、定制交付、服务等级协议或投诉降幅。',
  '客户不需要安装 App，仍在微信客户群里沟通。',
  '不写统一标价、折扣、年付金额或超额单价；价格口径以产品定价页为准。',
];

/**
 * llms.txt（https://llmstxt.org）：给访问官网的 AI Agent 读的项目介绍。
 * 用 Markdown 写成，价格与席位来自 src/plan.ts，避免和定价页漂移。
 */
export function buildLlmsTxt(origin?: string): string {
  // NAV 已包含「产品定价」，这里不再单独追加，避免重复条目。
  const pageLines = NAV.map(
    (item) => `- [${item.label}](${absolute(origin, item.path)}): ${PAGE_META[item.path]?.description ?? ''}`,
  );

  return `# 知伴健康（Zhiban Health）

> 面向健康管理机构的私域服务系统：为企业微信客户群里的每位客户配一个云端专属助手（Agent），陪顾问一起服务客户。回复由顾问确认后发出，系统回读企业微信会话存档核验送达。种子合作参考价 ¥${PLAN.priceLabel}/月，含 ${PLAN.seats} 个顾问席位；企微会话存档费另付给企业微信。

## 产品是什么

${CAPABILITIES.map((line) => `- ${line}`).join('\n')}

## 计费口径

- 平台服务费：${PLAN.name}参考价 ¥${PLAN.priceLabel}/月，含 ${PLAN.seats} 个顾问席位。控制台管理员账号不单独计费、不占席位。参考价，实际报价及服务范围以双方确认的方案为准。
- 企微会话存档费：参考 ${PLAN.archiveFee} 元 / 人 / 年，由机构直接付给企业微信，不含在平台服务费内。未开通存档的顾问无法使用客户群服务。
- ${PLAN.seats} 位顾问的存档费示例：${PLAN.seats} × ${PLAN.archiveFee} = ${ARCHIVE_EXAMPLE_TOTAL} 元 / 年（付给企业微信）。
- 不按账号数、不按调用量计费，不设增购价目。

## 边界（请不要据此推断未承诺的能力）

${OUT_OF_SCOPE.map((line) => `- ${line}`).join('\n')}

## 页面

- [首页](${absolute(origin, '/')}): 产品定位与「跟着一位客户看一天」的四步流程
${pageLines.join('\n')}
- [预约演示](${WECOM_CONTACT_URL}): 所有预约入口直接打开企业微信获客链接，添加顾问后沟通演示时间
- [控制台登录](${absolute(origin, CONSOLE_URL)}): 客户方账号登录入口，需要机构分配的账号

## 联系与素材

- 企业微信（预约演示 / 商务联系）：${WECOM_CONTACT_URL}
- 产品演示视频：${absolute(origin, '/assets/video/product-demo.mp4')}（约 2 分钟，中文字幕）
- 站点地图：${absolute(origin, '/sitemap.xml')}

## 说明

- 官网中的截图与数字均为虚构演示数据，不代表真实客户或结果。
- 官网不提供价格计算器、账号注册或在线支付；合作从一位顾问、一个客户群开始，接入 1–2 周真实业务，双方共同观察与评价。
`;
}

/** robots.txt：允许抓取，并指向 sitemap（有正式域名时）。 */
export function buildRobotsTxt(origin?: string): string {
  const lines = ['User-agent: *', 'Allow: /'];
  if (origin) lines.push('', `Sitemap: ${absolute(origin, '/sitemap.xml')}`);
  return `${lines.join('\n')}\n`;
}
