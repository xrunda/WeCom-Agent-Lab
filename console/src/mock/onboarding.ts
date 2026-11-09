import tenantFixture from './fixtures/tenant.json';
import { getSession, getTenant } from './api.ts';
import { ApiError, apiRequest, isMockMode } from './http.ts';
import { recordAudit } from './settings.ts';
import { mockId, readStore, removeStore, toQuery, writeStore } from './storage.ts';
import type {
  OnboardingInfo,
  OnboardingRequest,
  OnboardingRequestInput,
  OnboardingRequestStatus,
  Tenant,
} from '../types.ts';

const REQUESTS_KEY = 'zhiban.console.onboarding-requests';
const TENANT_ID = (tenantFixture as unknown as Tenant).id;

const PREREQUISITES: OnboardingInfo['prerequisites'] = [
  {
    id: 'verify-subject',
    title: '企微主体已认证',
    owner: 'customer',
    days: 0,
    materials: ['营业执照'],
  },
  {
    id: 'buy-archive',
    title: '购买会话存档席位（按顾问人数）',
    owner: 'customer',
    days: 1,
    materials: ['顾问名单'],
  },
  {
    id: 'create-app',
    title: '创建自建应用并授权客户群接口',
    owner: 'customer',
    days: 1,
    materials: ['企微管理员账号'],
  },
  {
    id: 'trusted-ip',
    title: '配置可信 IP',
    owner: 'both',
    days: 0,
    materials: ['服务器公网 IP'],
  },
  {
    id: 'advisor-consent',
    title: '顾问知情与授权',
    owner: 'customer',
    days: 0,
    materials: [],
  },
  {
    id: 'patient-consent',
    title: '患者存档同意告知',
    owner: 'customer',
    days: 1,
    materials: ['告知话术'],
  },
];

function loadRequests(): OnboardingRequest[] {
  return readStore<OnboardingRequest[]>(REQUESTS_KEY, []);
}

function saveRequests(items: OnboardingRequest[]): void {
  writeStore(REQUESTS_KEY, items);
}

/** GET /settings/onboarding */
export async function getOnboardingInfo(): Promise<OnboardingInfo> {
  if (!isMockMode) return apiRequest('/settings/onboarding');
  const tenant = await getTenant();
  return {
    prerequisites: PREREQUISITES,
    timeline: { minWorkdays: 3, maxWorkdays: 5, summary: '材料齐全后约 3–5 个工作日' },
    pricing: {
      archiveSeatPriceYuan: tenant.settings.archiveSeatPriceYuan,
      platformFeeText: '按方案报价',
      currency: 'CNY',
    },
    entryPoints: ['工作台价值条下方引导卡片', '系统设置 → 开通正式服务'],
  };
}

function validateRequest(input: OnboardingRequestInput): void {
  if (!input.contactName.trim()) {
    throw new ApiError('VALIDATION_FAILED', '请填写联系人姓名', 422);
  }
  if (!/^[0-9+\-\s]{6,20}$/.test(input.contactPhone.trim())) {
    throw new ApiError('VALIDATION_FAILED', '请填写有效的联系电话或企微号', 422);
  }
  if (!Number.isInteger(input.expectedAdvisors) || input.expectedAdvisors < 1 || input.expectedAdvisors > 1000) {
    throw new ApiError('VALIDATION_FAILED', '预计顾问人数需为 1–1000 的整数', 422);
  }
  if (!Number.isInteger(input.expectedPatients) || input.expectedPatients < 1 || input.expectedPatients > 1_000_000) {
    throw new ApiError('VALIDATION_FAILED', '预计服务人数需为 1–1000000 的整数', 422);
  }
  if (!input.consentToContact) {
    throw new ApiError('VALIDATION_FAILED', '需同意我方联系后才能提交', 422);
  }
}

/** POST /settings/onboarding/requests */
export async function submitOnboardingRequest(
  input: OnboardingRequestInput,
): Promise<OnboardingRequest> {
  if (!isMockMode) {
    return apiRequest('/settings/onboarding/requests', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  const session = await getSession();
  if (!session) {
    throw new ApiError('UNAUTHORIZED', '请先登录', 401);
  }
  if (session.account.role === 'viewer') {
    throw new ApiError('FORBIDDEN', '只读账号不能提交开通申请', 403);
  }
  validateRequest(input);

  const request: OnboardingRequest = {
    id: mockId('obr'),
    tenantId: TENANT_ID,
    contactName: input.contactName.trim(),
    contactPhone: input.contactPhone.trim(),
    contactTitle: input.contactTitle?.trim() || null,
    expectedAdvisors: input.expectedAdvisors,
    expectedPatients: input.expectedPatients,
    note: input.note?.trim() || null,
    consentToContact: true,
    status: 'submitted',
    createdBy: session.account.id,
    createdAt: Date.now(),
    handledBy: null,
    handledAt: null,
  };
  saveRequests([request, ...loadRequests()]);
  await recordAudit({
    action: 'onboarding.submit',
    targetType: 'onboarding_request',
    targetId: request.id,
    detail: {
      expectedAdvisors: request.expectedAdvisors,
      expectedPatients: request.expectedPatients,
    },
  });
  return request;
}

/** GET /settings/onboarding/requests?status= */
export async function listOnboardingRequests(
  status?: OnboardingRequestStatus,
): Promise<{ items: OnboardingRequest[] }> {
  if (!isMockMode) {
    return apiRequest(`/settings/onboarding/requests${toQuery({ status })}`);
  }
  const session = await getSession();
  if (!session) {
    throw new ApiError('UNAUTHORIZED', '请先登录', 401);
  }
  if (session.account.role !== 'admin') {
    throw new ApiError('FORBIDDEN', '仅管理员可查看开通申请', 403);
  }
  const items = loadRequests()
    .filter((item) => (status ? item.status === status : true))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { items };
}

/** 仅供测试：恢复开通申请 mock 状态 */
export function resetOnboardingState(): void {
  removeStore(REQUESTS_KEY);
}
