import {
  AlertOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BookOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CommentOutlined,
  CustomerServiceOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  HeartOutlined,
  IdcardOutlined,
  KeyOutlined,
  LockOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuDataItem } from '@ant-design/pro-components';

/**
 * 完整菜单（P1-scope §4）。C 档入口用 `soon: true` 标记，
 * 由 ConsoleLayout 在菜单文字后追加「即将上线」角标。
 * 称谓相关文案从参数传入，避免写死「患者」。
 */
export function buildMenuItems(term: string): MenuDataItem[] {
  return [
    {
      path: '/dashboard',
      name: '工作台',
      icon: <DashboardOutlined />,
    },
    {
      path: '/patients',
      name: `${term} Agent`,
      icon: <HeartOutlined />,
    },
    {
      key: 'service',
      name: '服务中心',
      icon: <CustomerServiceOutlined />,
      children: [
        { path: '/service-flow', name: '实时服务流', icon: <ThunderboltOutlined /> },
        { path: '/sandbox', name: '体验中心（沙盒）', icon: <ExperimentOutlined /> },
        { path: '/alerts', name: '质检与告警', icon: <AlertOutlined /> },
      ],
    },
    {
      key: 'operations',
      name: '客户运营',
      icon: <ShopOutlined />,
      children: [
        { path: '/groups', name: '服务群', icon: <TeamOutlined /> },
        { path: '/checkins', name: '健康打卡', icon: <CheckCircleOutlined />, soon: true },
      ],
    },
    {
      key: 'team',
      name: '团队',
      icon: <IdcardOutlined />,
      children: [
        { path: '/advisors', name: '顾问', icon: <UserOutlined /> },
        { path: '/shifts', name: '排班与交接', icon: <CalendarOutlined />, soon: true },
      ],
    },
    {
      key: 'intelligence',
      name: '智能配置',
      icon: <RobotOutlined />,
      children: [
        { path: '/knowledge', name: '知识库', icon: <BookOutlined /> },
        { path: '/rules', name: '风险规则', icon: <SafetyCertificateOutlined /> },
        { path: '/scripts', name: '话术库', icon: <CommentOutlined /> },
      ],
    },
    {
      path: '/skills',
      name: '技能市场',
      icon: <AppstoreOutlined />,
    },
    {
      path: '/reports',
      name: '数据报表',
      icon: <BarChartOutlined />,
    },
    {
      path: '/solutions',
      name: '行业方案包',
      icon: <DeploymentUnitOutlined />,
    },
    {
      key: 'settings',
      name: '系统设置',
      icon: <SettingOutlined />,
      children: [
        { path: '/settings/agent', name: 'Agent 设定', icon: <RobotOutlined /> },
        { path: '/settings/wecom', name: '企微接入状态', icon: <CloudServerOutlined /> },
        { path: '/settings/model', name: 'AI 模型', icon: <ThunderboltOutlined /> },
        { path: '/settings/accounts', name: '账号与角色', icon: <TeamOutlined /> },
        { path: '/settings/audit', name: '审计日志', icon: <AuditOutlined /> },
        { path: '/settings/security', name: '数据与安全', icon: <LockOutlined /> },
        { path: '/settings/onboarding', name: '开通正式服务', icon: <KeyOutlined /> },
      ],
    },
  ];
}

/** 页面标题与说明用同一份元数据，路由和占位页共用 */
export interface PageMeta {
  path: string;
  title: string;
  description: string;
  tier: 'A' | 'B' | 'C';
}

export function buildPageMeta(term: string): PageMeta[] {
  return [
    {
      path: '/dashboard',
      title: '工作台',
      description: '价值条、KPI、趋势与最近服务动态。',
      tier: 'B',
    },
    {
      path: '/patients',
      title: `${term} Agent`,
      description: `管理${term}档案、记忆、主动计划与办事记录。`,
      tier: 'A',
    },
    {
      path: '/service-flow',
      title: '实时服务流',
      description: '草稿从生成到核验的完整生命周期。',
      tier: 'A',
    },
    {
      path: '/sandbox',
      title: '体验中心（沙盒）',
      description: '用模拟渠道体验完整的服务闭环。',
      tier: 'A',
    },
    {
      path: '/alerts',
      title: '质检与告警',
      description: '发错群、未核验、超时升级与死信处理。',
      tier: 'A',
    },
    {
      path: '/groups',
      title: '服务群',
      description: '服务群发现、绑定与服务状态管理。',
      tier: 'A',
    },
    {
      path: '/checkins',
      title: '健康打卡',
      description: '打卡计划、提醒与依从性统计。',
      tier: 'C',
    },
    {
      path: '/advisors',
      title: '顾问',
      description: '席位、在线状态、队列与绩效。',
      tier: 'B',
    },
    {
      path: '/shifts',
      title: '排班与交接',
      description: '排班、交接班与工作量分配。',
      tier: 'C',
    },
    {
      path: '/knowledge',
      title: '知识库',
      description: '按分类维护知识条目与命中统计。',
      tier: 'A',
    },
    {
      path: '/rules',
      title: '风险规则',
      description: '红线与关键词规则，命中后标记风险。',
      tier: 'B',
    },
    {
      path: '/scripts',
      title: '话术库',
      description: '常用话术示例与团队共享。',
      tier: 'B',
    },
    {
      path: '/skills',
      title: '技能市场',
      description: '已安装的插件能力与即将上线的技能。',
      tier: 'A',
    },
    {
      path: '/reports',
      title: '数据报表',
      description: '服务量、采纳率与团队效率报表。',
      tier: 'B',
    },
    {
      path: '/solutions',
      title: '行业方案包',
      description: '健康调理、体重管理、慢病随访等方案包。',
      tier: 'B',
    },
    {
      path: '/settings/agent',
      title: 'Agent 设定',
      description: `Agent 名字、${term}称谓与语气。`,
      tier: 'A',
    },
    {
      path: '/settings/wecom',
      title: '企微接入状态',
      description: '存档 SDK、机器人长连接与席位状态。',
      tier: 'A',
    },
    {
      path: '/settings/model',
      title: 'AI 模型',
      description: '当前模型、调用次数与降级统计。',
      tier: 'A',
    },
    {
      path: '/settings/accounts',
      title: '账号与角色',
      description: '机构管理员、主管与只读账号。',
      tier: 'A',
    },
    {
      path: '/settings/audit',
      title: '审计日志',
      description: '操作与状态变化记录，可筛选导出。',
      tier: 'A',
    },
    {
      path: '/settings/security',
      title: '数据与安全',
      description: '数据存放、模型服务、加密与留存事实。',
      tier: 'A',
    },
    {
      path: '/settings/onboarding',
      title: '开通正式服务',
      description: '接入机构自有企微的前置条件、时间线与席位估算。',
      tier: 'A',
    },
  ];
}
