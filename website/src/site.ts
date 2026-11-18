export interface NavItem {
  path: string;
  label: string;
}

/** 官网固定导航（issue #217）。顺序不可改。 */
export const NAV: NavItem[] = [
  { path: '/customer-agent', label: '客户专属助手' },
  { path: '/advisor', label: '顾问工作台' },
  { path: '/management', label: '机构管理' },
  { path: '/scenarios', label: '业务场景' },
  { path: '/pricing', label: '产品定价' },
];

export const SITE_TAGLINE = '知伴健康 · 为健康服务机构提供客户跟进与团队协作工具';

/** 企业微信「联系我」获客链接：所有「预约演示」入口直接打开这里。 */
export const WECOM_CONTACT_URL = 'https://work.weixin.qq.com/ca/cawcded818a8d398cf';

export interface PageMeta {
  path: string;
  title: string;
  description: string;
}

export const PAGE_META: Record<string, PageMeta> = {
  '/': {
    path: '/',
    title: '知伴健康',
    description: '每位客户，都有一位记得他、会提醒顾问的健康助手。',
  },
  '/customer-agent': {
    path: '/customer-agent',
    title: '客户专属助手 · 知伴健康',
    description: '换了顾问，客户也不用把情况再讲一遍。知伴为每位客户建立一个专属助手。',
  },
  '/advisor': {
    path: '/advisor',
    title: '顾问工作台 · 知伴健康',
    description: '系统主动提醒，顾问也能在企微里直接交代事情。',
  },
  '/management': {
    path: '/management',
    title: '机构管理 · 知伴健康',
    description: '哪些客户还没跟进，负责人打开后台就能查。',
  },
  '/scenarios': {
    path: '/scenarios',
    title: '业务场景 · 知伴健康',
    description: '一对一健康指导群，每天的服务怎么跟下来。',
  },
  '/pricing': {
    path: '/pricing',
    title: '产品定价 · 知伴健康',
    description: '了解知伴健康种子合作方案、平台服务内容、企业微信会话存档费用与业务接入方式。',
  },
};
