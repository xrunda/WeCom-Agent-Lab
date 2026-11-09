/**
 * 控制台 B 档示例数据集（#49）。
 *
 * 规则：
 * - 全部为虚构数据，不使用任何真实机构、客户或聊天内容。
 * - 数字相互自洽：顾问汇总 = 趋势汇总 = 420 条；核验结果四类之和 = 420；
 *   客户消息数按顾问归属求和 = 420。
 * - 只用于工作台示例趋势/排行与数据报表，不进入真实接口口径。
 */

export interface SampleDay {
  date: string;
  label: string;
  volume: number;
  verified: number;
}

export interface SampleAdvisor {
  id: string;
  name: string;
  title: string;
  patientCount: number;
  volume: number;
  verified: number;
  editSent: number;
  misroute: number;
  unverified: number;
  avgResponseSeconds: number;
}

export interface SamplePatient {
  id: string;
  name: string;
  advisorId: string;
  advisorName: string;
  messages: number;
  lastActiveAt: number;
  activity: 'active' | 'quiet';
}

export const SAMPLE_PERIOD_LABEL = '近 14 天（2026-10-26 至 2026-11-08）';

export const SAMPLE_DAYS: SampleDay[] = [
  { date: '2026-10-26', label: '10-26', volume: 26, verified: 21 },
  { date: '2026-10-27', label: '10-27', volume: 31, verified: 27 },
  { date: '2026-10-28', label: '10-28', volume: 29, verified: 24 },
  { date: '2026-10-29', label: '10-29', volume: 34, verified: 29 },
  { date: '2026-10-30', label: '10-30', volume: 28, verified: 24 },
  { date: '2026-10-31', label: '10-31', volume: 32, verified: 27 },
  { date: '2026-11-01', label: '11-01', volume: 25, verified: 21 },
  { date: '2026-11-02', label: '11-02', volume: 30, verified: 26 },
  { date: '2026-11-03', label: '11-03', volume: 33, verified: 28 },
  { date: '2026-11-04', label: '11-04', volume: 27, verified: 23 },
  { date: '2026-11-05', label: '11-05', volume: 31, verified: 26 },
  { date: '2026-11-06', label: '11-06', volume: 29, verified: 25 },
  { date: '2026-11-07', label: '11-07', volume: 35, verified: 30 },
  { date: '2026-11-08', label: '11-08', volume: 30, verified: 25 },
];

export const SAMPLE_ADVISORS: SampleAdvisor[] = [
  {
    id: 'adv_li',
    name: '李顾问',
    title: '资深健康顾问',
    patientCount: 4,
    volume: 154,
    verified: 132,
    editSent: 15,
    misroute: 3,
    unverified: 4,
    avgResponseSeconds: 72,
  },
  {
    id: 'adv_wang',
    name: '王顾问',
    title: '健康顾问',
    patientCount: 4,
    volume: 142,
    verified: 121,
    editSent: 12,
    misroute: 2,
    unverified: 7,
    avgResponseSeconds: 85,
  },
  {
    id: 'adv_zhao',
    name: '赵顾问',
    title: '健康顾问',
    patientCount: 4,
    volume: 124,
    verified: 103,
    editSent: 10,
    misroute: 1,
    unverified: 10,
    avgResponseSeconds: 96,
  },
];

export const SAMPLE_PATIENTS: SamplePatient[] = [
  { id: 'demo_p01', name: '陈女士', advisorId: 'adv_li', advisorName: '李顾问', messages: 48, lastActiveAt: Date.parse('2026-11-08T20:12:00+08:00'), activity: 'active' },
  { id: 'demo_p02', name: '刘先生', advisorId: 'adv_li', advisorName: '李顾问', messages: 42, lastActiveAt: Date.parse('2026-11-08T18:40:00+08:00'), activity: 'active' },
  { id: 'demo_p03', name: '周女士', advisorId: 'adv_li', advisorName: '李顾问', messages: 35, lastActiveAt: Date.parse('2026-11-07T09:25:00+08:00'), activity: 'active' },
  { id: 'demo_p04', name: '吴先生', advisorId: 'adv_li', advisorName: '李顾问', messages: 29, lastActiveAt: Date.parse('2026-10-18T16:05:00+08:00'), activity: 'quiet' },
  { id: 'demo_p05', name: '王女士', advisorId: 'adv_wang', advisorName: '王顾问', messages: 40, lastActiveAt: Date.parse('2026-11-08T11:18:00+08:00'), activity: 'active' },
  { id: 'demo_p06', name: '郑先生', advisorId: 'adv_wang', advisorName: '王顾问', messages: 38, lastActiveAt: Date.parse('2026-11-08T08:52:00+08:00'), activity: 'active' },
  { id: 'demo_p07', name: '孙女士', advisorId: 'adv_wang', advisorName: '王顾问', messages: 34, lastActiveAt: Date.parse('2026-11-06T21:03:00+08:00'), activity: 'active' },
  { id: 'demo_p08', name: '何先生', advisorId: 'adv_wang', advisorName: '王顾问', messages: 30, lastActiveAt: Date.parse('2026-10-21T10:46:00+08:00'), activity: 'quiet' },
  { id: 'demo_p09', name: '赵女士', advisorId: 'adv_zhao', advisorName: '赵顾问', messages: 33, lastActiveAt: Date.parse('2026-11-08T19:30:00+08:00'), activity: 'active' },
  { id: 'demo_p10', name: '黄先生', advisorId: 'adv_zhao', advisorName: '赵顾问', messages: 32, lastActiveAt: Date.parse('2026-11-07T15:10:00+08:00'), activity: 'active' },
  { id: 'demo_p11', name: '林女士', advisorId: 'adv_zhao', advisorName: '赵顾问', messages: 31, lastActiveAt: Date.parse('2026-11-07T12:36:00+08:00'), activity: 'active' },
  { id: 'demo_p12', name: '徐先生', advisorId: 'adv_zhao', advisorName: '赵顾问', messages: 28, lastActiveAt: Date.parse('2026-10-23T17:22:00+08:00'), activity: 'quiet' },
];

export const SAMPLE_TOTALS = {
  volume: SAMPLE_DAYS.reduce((sum, day) => sum + day.volume, 0),
  verified: SAMPLE_DAYS.reduce((sum, day) => sum + day.verified, 0),
  advisors: SAMPLE_ADVISORS.length,
  patients: SAMPLE_PATIENTS.length,
  messages: SAMPLE_PATIENTS.reduce((sum, patient) => sum + patient.messages, 0),
};

export const SAMPLE_OUTCOMES = [
  { outcome: 'verified', label: '已核验', count: SAMPLE_TOTALS.verified, color: '#0f766e' },
  {
    outcome: 'edit_sent',
    label: '改后发送',
    count: SAMPLE_ADVISORS.reduce((sum, advisor) => sum + advisor.editSent, 0),
    color: '#0ea5e9',
  },
  {
    outcome: 'misroute',
    label: '发错群',
    count: SAMPLE_ADVISORS.reduce((sum, advisor) => sum + advisor.misroute, 0),
    color: '#f59e0b',
  },
  {
    outcome: 'unverified',
    label: '未核验',
    count: SAMPLE_ADVISORS.reduce((sum, advisor) => sum + advisor.unverified, 0),
    color: '#ef4444',
  },
];

/** 加权平均响应时长，与顾问数据一致（四舍五入到秒） */
export const SAMPLE_AVG_RESPONSE_SECONDS = Math.round(
  SAMPLE_ADVISORS.reduce((sum, advisor) => sum + advisor.avgResponseSeconds * advisor.volume, 0) /
    SAMPLE_TOTALS.volume,
);

export const SAMPLE_PASS_RATE = SAMPLE_TOTALS.verified / SAMPLE_TOTALS.volume;
