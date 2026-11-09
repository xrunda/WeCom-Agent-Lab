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
