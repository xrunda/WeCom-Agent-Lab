import { describe, expect, it } from 'vitest';

import {
  MOCK_PASSWORD,
  getSession,
  getTenant,
  login,
  logout,
  resetMockState,
  updateTenant,
} from '../src/mock/api.ts';
import { PATIENT_TERM_MAX_LENGTH } from '../src/types.ts';

describe('mock API', () => {
  it('管理员用演示密码登录', async () => {
    resetMockState();
    const session = await login('admin', MOCK_PASSWORD);

    expect(session.account.displayName).toBe('林主管');
    expect(session.account.role).toBe('admin');
    expect(session.tenant.patientTerm).toBe('患者');
  });

  it('错误密码返回 INVALID_CREDENTIALS', async () => {
    await expect(login('admin', 'wrong-password')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
  });

  it('未知账号不泄露账号是否存在', async () => {
    await expect(login('nobody', MOCK_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('更新称谓后会话与租户同步', async () => {
    await login('admin', MOCK_PASSWORD);
    const tenant = await updateTenant({ patientTerm: '会员' });

    expect(tenant.patientTerm).toBe('会员');
    expect((await getTenant()).patientTerm).toBe('会员');
    expect((await getSession())?.tenant.patientTerm).toBe('会员');
  });

  it('称谓支持自定义，长度与空白受约束', async () => {
    await login('admin', MOCK_PASSWORD);

    const tenant = await updateTenant({ patientTerm: ' 亲人 ' });
    expect(tenant.patientTerm).toBe('亲人');

    await expect(updateTenant({ patientTerm: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      updateTenant({ patientTerm: 'x'.repeat(PATIENT_TERM_MAX_LENGTH + 1) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('退出登录后没有会话', async () => {
    await login('admin', MOCK_PASSWORD);
    await logout();
    expect(await getSession()).toBeNull();
  });
});
