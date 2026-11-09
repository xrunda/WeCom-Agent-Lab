import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_PASSWORD, login, resetMockState, updateTenant } from '../src/mock/api.ts';
import { getDashboardValue } from '../src/mock/dashboard.ts';
import {
  getOnboardingInfo,
  listOnboardingRequests,
  resetOnboardingState,
  submitOnboardingRequest,
} from '../src/mock/onboarding.ts';
import { listAudit, resetSettingsState } from '../src/mock/settings.ts';

const VALID_INPUT = {
  contactName: '赵经理',
  contactPhone: '13800000000',
  contactTitle: '运营负责人',
  expectedAdvisors: 5,
  expectedPatients: 200,
  note: '希望下月上线',
  consentToContact: true,
};

beforeEach(() => {
  resetMockState();
  resetSettingsState();
  resetOnboardingState();
});

describe('WP-M 价值看板 mock', () => {
  it('采纳率三类相加等于已发出，节省时长按租户口径计算', async () => {
    const value = await getDashboardValue('today');
    const { original, revised, edited, sentTotal } = value.adoption;
    expect(original + revised + edited).toBe(sentTotal);
    expect(value.savedMinutes).toBe((original + revised) * 3);
    expect(value.minutesPerDraft).toBe(3);
    expect(value.savedMinutesBasis).toContain('× 3 分钟');
  });

  it('修改单条撰写时长后节省时长同步变化', async () => {
    await login('admin', MOCK_PASSWORD);
    const before = await getDashboardValue('week');
    expect(before.savedMinutes).toBe(
      (before.adoption.original + before.adoption.revised) * 3,
    );

    await updateTenant({ settings: { writeMinutesPerDraft: 5 } });
    const after = await getDashboardValue('week');
    expect(after.minutesPerDraft).toBe(5);
    expect(after.savedMinutes).toBe(
      (after.adoption.original + after.adoption.revised) * 5,
    );
    expect(after.savedMinutesBasis).toContain('× 5 分钟');
    expect(after.adoption).toEqual(before.adoption);
  });
});

describe('WP-M 开通正式服务 mock', () => {
  it('前置条件、时间线与单价来自配置', async () => {
    const info = await getOnboardingInfo();
    expect(info.prerequisites).toHaveLength(6);
    expect(info.prerequisites.map((item) => item.id)).toContain('buy-archive');
    expect(info.timeline.minWorkdays).toBe(3);
    expect(info.timeline.maxWorkdays).toBe(5);
    expect(info.pricing.archiveSeatPriceYuan).toBe(900);
    expect(info.pricing.platformFeeText).toBe('按方案报价');
  });

  it('单价可在租户设置中修改，开通页回读新值', async () => {
    await login('admin', MOCK_PASSWORD);
    await updateTenant({ settings: { archiveSeatPriceYuan: 1200 } });
    const info = await getOnboardingInfo();
    expect(info.pricing.archiveSeatPriceYuan).toBe(1200);
  });

  it('管理员提交申请后列表可查，并写入审计', async () => {
    await login('admin', MOCK_PASSWORD);
    const request = await submitOnboardingRequest(VALID_INPUT);
    expect(request.id.startsWith('obr_')).toBe(true);
    expect(request.status).toBe('submitted');
    expect(request.contactName).toBe('赵经理');
    expect(request.createdBy).toBeTruthy();

    const list = await listOnboardingRequests();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(request.id);

    const audit = await listAudit({ action: 'onboarding.submit', targetId: request.id });
    expect(audit.total).toBe(1);
    expect(audit.items[0].targetId).toBe(request.id);
    expect(audit.items[0].detail).not.toHaveProperty('contactPhone');
  });

  it('只读账号不能提交申请', async () => {
    await login('viewer', MOCK_PASSWORD);
    await expect(submitOnboardingRequest(VALID_INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('未登录或非管理员不能查看开通申请列表', async () => {
    await expect(listOnboardingRequests()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });

    await login('viewer', MOCK_PASSWORD);
    await expect(listOnboardingRequests()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    await login('supervisor', MOCK_PASSWORD);
    await expect(listOnboardingRequests()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('缺姓名、未同意联系或人数越界时拒绝提交', async () => {
    await login('admin', MOCK_PASSWORD);
    await expect(
      submitOnboardingRequest({ ...VALID_INPUT, contactName: '  ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      submitOnboardingRequest({ ...VALID_INPUT, consentToContact: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      submitOnboardingRequest({ ...VALID_INPUT, expectedAdvisors: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      submitOnboardingRequest({ ...VALID_INPUT, expectedPatients: 2_000_000 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const list = await listOnboardingRequests();
    expect(list.items).toHaveLength(0);
  });
});
