export type Role = 'admin' | 'supervisor' | 'viewer';

export type PatientTerm = '患者' | '客户' | '会员';

export const PATIENT_TERMS: PatientTerm[] = ['患者', '客户', '会员'];

export interface TenantSettings {
  archiveSeatPriceYuan: number;
  writeMinutesPerDraft: number;
  mergeWindowSeconds: number;
  quietHours: { start: string; end: string };
  proactivePerHour: number;
  modelName: string;
  memoryInjectLimit: number;
  retentionNotice: string;
}

export interface Tenant {
  id: string;
  name: string;
  agentName: string;
  agentAvatar: string | null;
  patientTerm: PatientTerm;
  tone: string;
  timezone: string;
  settings: TenantSettings;
  createdAt: number;
  updatedAt: number;
}

export interface Account {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Session {
  account: Pick<Account, 'id' | 'displayName' | 'role'>;
  tenant: Tenant;
  permissions: string[];
  serverTime: number;
}

/* ---------- WP-L：知识 / 规则 / 话术 ---------- */

export interface KnowledgeEntry {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  content: string;
  enabled: boolean;
  hits: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type RiskRuleKind = 'redline' | 'keyword';
export type RiskLevel = 'high' | 'medium' | 'low';
export type RiskAction = 'flag' | 'escalate';

export interface RiskRule {
  id: string;
  tenantId: string;
  kind: RiskRuleKind;
  name: string;
  keywords: string[];
  riskLevel: RiskLevel;
  action: RiskAction;
  enabled: boolean;
  builtin: boolean;
  hitCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptTemplate {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  enabled: boolean;
  /** 仅 mock 示例数据为 true；真接口不返回该字段 */
  sample?: boolean;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}

/* ---------- WP-L：技能与方案包 ---------- */

export type SkillStatus = 'enabled' | 'disabled' | 'coming_soon';

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string | null;
  status: SkillStatus;
  pluginId: string | null;
  capabilities: string[];
  tier: 'A' | 'B' | 'C';
}

export interface SolutionPack {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  status: 'enabled' | 'coming_soon';
  skillIds: string[];
  knowledgeCount: number;
  ruleCount: number;
  updatedAt: number;
}

/* ---------- WP-L：工作台 / 报表 ---------- */

export type DashboardRange = 'today' | 'week' | 'month';

export interface DashboardKpis {
  range: DashboardRange;
  onlineAgents: number;
  proactiveToday: number;
  memoriesToday: number;
  draftsToday: number;
  verificationPassRate: number;
  avgResponseSeconds: number;
  openAlerts: number;
  computedAt: number;
}

export interface DashboardTrendPoint {
  date: string;
  label: string;
  volume: number;
  verified: number;
}

export interface DashboardAdvisorRank {
  advisorId: string;
  name: string;
  status: string;
  volume: number;
  verified: number;
  avgResponseSeconds: number;
}

export interface DashboardValue {
  range: DashboardRange;
  from: number;
  to: number;
  /** 真实接口返回的近 14 天草稿量；mock 模式不提供 */
  trend?: DashboardTrendPoint[];
  advisorRanking?: DashboardAdvisorRank[];
  adoption: {
    original: number;
    revised: number;
    edited: number;
    sentTotal: number;
    rate: number;
    rateFormula: string;
  };
  savedMinutes: number;
  savedMinutesBasis: string;
  minutesPerDraft: number;
  proactiveCareCount: number;
  verificationPassRate: number;
  patientsPerAdvisor: number;
  computedAt: number;
}

export interface DashboardRecentItem {
  id: string;
  patientName: string;
  advisorName: string;
  groupName: string;
  preview: string;
  outcome: 'verified' | 'edit_sent' | 'misroute' | 'unverified' | 'pending';
  at: number;
  sandbox: boolean;
}

/* ---------- WP-L：设置 / 账号 / 审计 ---------- */

export interface WecomChannelStatus {
  status: 'green' | 'yellow' | 'red';
  message: string;
}

export interface WecomStatus {
  archive: WecomChannelStatus & {
    lastPolledAt: number | null;
    lastSeq: number | null;
    lagSeconds: number | null;
  };
  bot: WecomChannelStatus & {
    connectedSince: number | null;
    lastDisconnectAt: number | null;
  };
  host: WecomChannelStatus & {
    uptimeSeconds: number | null;
    version: string | null;
  };
  seat: {
    purchased: number;
    expiresAt: number | null;
    message: string;
  };
  checkedAt: number;
}

export interface ModelStatus {
  model: string;
  callsToday: number;
  avgLatencyMs: number;
  fallbackCount: number;
  estimatedCostYuanToday: number;
  updatedAt: number;
}

export interface PermissionMatrix {
  roles: Array<{
    role: Role;
    label: string;
    permissions: string[];
  }>;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorType: 'account' | 'system' | 'agent';
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: 'success' | 'failure';
  detail: Record<string, unknown> | null;
  errorCode: string | null;
  ip: string;
  at: number;
  sandbox: boolean;
}

export interface AuditFilters {
  actorType?: AuditEvent['actorType'];
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  result?: AuditEvent['result'];
  from?: number;
  to?: number;
  sandbox?: boolean;
  page?: number;
  pageSize?: number;
}

/* ---------- WP-M：价值看板与开通正式服务 ---------- */

export interface OnboardingPrerequisite {
  id: string;
  title: string;
  owner: 'customer' | 'both';
  days: number;
  materials: string[];
}

export interface OnboardingInfo {
  prerequisites: OnboardingPrerequisite[];
  timeline: { minWorkdays: number; maxWorkdays: number; summary: string };
  pricing: { archiveSeatPriceYuan: number; platformFeeText: string; currency: string };
  entryPoints: string[];
}

export type OnboardingRequestStatus = 'submitted' | 'contacted' | 'closed';

export interface OnboardingRequest {
  id: string;
  tenantId: string;
  contactName: string;
  contactPhone: string;
  contactTitle: string | null;
  expectedAdvisors: number;
  expectedPatients: number;
  note: string | null;
  consentToContact: boolean;
  status: OnboardingRequestStatus;
  createdBy: string;
  createdAt: number;
  handledBy: string | null;
  handledAt: number | null;
}

export interface OnboardingRequestInput {
  contactName: string;
  contactPhone: string;
  contactTitle?: string;
  expectedAdvisors: number;
  expectedPatients: number;
  note?: string;
  consentToContact: boolean;
}

/* ---------- #59：数据与安全 ---------- */

export interface SecurityOverview {
  deployment: {
    dataRegion: string;
    modelRegion: string;
    modelService: string;
    transport: string;
    retentionNotice: string;
    dataStores: string[];
  };
  retention: {
    notice: string;
    autoDelete: boolean;
  };
  roles: string[];
  access: {
    roles: Array<{ role: Role; label: string; permissions: string[] }>;
  };
  audit: {
    enabled: boolean;
    exportable: boolean;
    retention: string;
    events30d: number;
    exports30d: number;
    lastExportAt: number | null;
  };
  consent: {
    agreed: number;
    unknown: number;
    disagreed: number;
    total: number;
  } | null;
  pdf: {
    fontConfigured: boolean;
  };
  generatedAt: number;
}
