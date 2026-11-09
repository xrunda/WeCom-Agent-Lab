import { beforeEach, describe, expect, it } from 'vitest';

import {
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  listKnowledgeCategories,
  resetKnowledgeState,
  updateKnowledge,
} from '../src/mock/knowledge.ts';
import { createRiskRule, deleteRiskRule, listRiskRules, resetRulesState, updateRiskRule } from '../src/mock/rules.ts';
import { listScripts, resetScriptsState } from '../src/mock/scripts.ts';
import {
  getDashboardKpis,
  getDashboardRecent,
  getDashboardValue,
} from '../src/mock/dashboard.ts';
import { getSkill, listSkills, listSolutionPacks } from '../src/mock/skills.ts';
import {
  MOCK_PASSWORD,
  login,
  resetMockState,
} from '../src/mock/api.ts';
import {
  createAccount,
  deleteAccount,
  exportAuditCsv,
  getPermissionMatrix,
  getWecomStatus,
  listAccounts,
  listAudit,
  resetAccountPassword,
  resetSettingsState,
  setMockBotConnected,
  updateAccount,
} from '../src/mock/settings.ts';
import {
  SAMPLE_ADVISORS,
  SAMPLE_AVG_RESPONSE_SECONDS,
  SAMPLE_OUTCOMES,
  SAMPLE_TOTALS,
} from '../src/sample/index.ts';

beforeEach(() => {
  resetMockState();
  resetKnowledgeState();
  resetRulesState();
  resetScriptsState();
  resetSettingsState();
});

describe('知识库 mock', () => {
  it('分类计数、新增、停用与软删除', async () => {
    const initial = await listKnowledge();
    expect(initial.total).toBe(8);

    const categories = await listKnowledgeCategories();
    expect(categories.items.find((item) => item.category === '饮食建议')?.count).toBe(3);

    const created = await createKnowledge({
      category: '测试分类',
      title: '测试知识',
      content: '仅用于测试的虚构内容。',
    });
    expect((await listKnowledge()).total).toBe(9);

    const disabled = await updateKnowledge(created.id, { enabled: false, title: '测试知识（改）' });
    expect(disabled.enabled).toBe(false);
    expect(disabled.title).toBe('测试知识（改）');

    await deleteKnowledge(created.id);
    const after = await listKnowledge();
    expect(after.total).toBe(8);
    expect(after.items.some((item) => item.id === created.id)).toBe(false);
  });

  it('搜索与启用筛选', async () => {
    const result = await listKnowledge({ q: '晚餐', enabled: true });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toContain('晚餐');
  });

  it('必填校验', async () => {
    await expect(createKnowledge({ category: '', title: 'x', content: 'y' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('风险规则 mock', () => {
  it('内置红线只读，关键词规则可增删改', async () => {
    const initial = await listRiskRules();
    expect(initial.total).toBe(7);
    const builtin = initial.items.find((rule) => rule.builtin);
    expect(builtin).toBeTruthy();

    await expect(updateRiskRule(builtin!.id, { enabled: false })).rejects.toMatchObject({
      code: 'BUILTIN_RULE',
      status: 409,
    });
    await expect(deleteRiskRule(builtin!.id)).rejects.toMatchObject({ code: 'BUILTIN_RULE' });

    const created = await createRiskRule({
      name: '测试-关键词',
      keywords: ['测试词', '测试词 '],
      riskLevel: 'medium',
      action: 'flag',
    });
    expect(created.keywords).toEqual(['测试词']);

    const updated = await updateRiskRule(created.id, { enabled: false, riskLevel: 'low' });
    expect(updated.enabled).toBe(false);
    expect(updated.riskLevel).toBe('low');

    await deleteRiskRule(created.id);
    expect((await listRiskRules()).total).toBe(7);
  });

  it('关键词不能为空', async () => {
    await expect(
      createRiskRule({ name: '空关键词', keywords: [], riskLevel: 'high', action: 'flag' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('话术库 mock', () => {
  it('返回示例标记并支持分类与搜索', async () => {
    const all = await listScripts();
    expect(all.sample).toBe(true);
    expect(all.total).toBe(8);

    const diet = await listScripts({ category: '饮食' });
    expect(diet.items).toHaveLength(2);

    const search = await listScripts({ q: '外食' });
    expect(search.items[0].title).toContain('外食');
  });
});

describe('工作台 mock', () => {
  it('KPI 与价值条按范围返回，数字自洽', async () => {
    const today = await getDashboardValue('today');
    expect(today.adoption.original + today.adoption.revised + today.adoption.edited).toBe(
      today.adoption.sentTotal,
    );
    expect(today.savedMinutes).toBe((today.adoption.original + today.adoption.revised) * 3);

    const week = await getDashboardKpis('week');
    expect(week.range).toBe('week');
    expect(week.draftsToday).toBeGreaterThan(0);
    expect(week.verificationPassRate).toBeGreaterThan(0);
    expect(week.verificationPassRate).toBeLessThanOrEqual(1);
  });

  it('最近动态按数量限制且不含沙盒数据', async () => {
    const recent = await getDashboardRecent(3);
    expect(recent.items).toHaveLength(3);
    expect(recent.items.every((item) => item.sandbox === false)).toBe(true);
  });
});

describe('技能与方案包 mock', () => {
  it('已启用 7 项、即将上线 4 项，方案包 6 个', async () => {
    const skills = await listSkills();
    expect(skills.installed).toHaveLength(7);
    expect(skills.upcoming).toHaveLength(4);
    expect(skills.installed.some((skill) => skill.name === '餐食图片识别')).toBe(true);

    const detail = await getSkill('skl_device');
    expect(detail?.status).toBe('coming_soon');

    const packs = await listSolutionPacks();
    expect(packs.total).toBe(6);
    expect(packs.items.filter((pack) => pack.status === 'enabled')).toHaveLength(1);
  });
});

describe('账号与审计 mock', () => {
  it('新建账号、重复用户名、重置密码与删除', async () => {
    await login('admin', MOCK_PASSWORD);
    const created = await createAccount({
      username: 'test.advisor',
      displayName: '测试顾问',
      role: 'supervisor',
      password: 'demo-pass-123',
    });
    expect(created.status).toBe('active');

    await expect(
      createAccount({
        username: 'test.advisor',
        displayName: '重复',
        role: 'viewer',
        password: 'demo-pass-123',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    await expect(resetAccountPassword(created.id, 'short')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await resetAccountPassword(created.id, 'new-pass-123');

    await deleteAccount(created.id);
    const list = await listAccounts();
    expect(list.items.some((account) => account.id === created.id)).toBe(false);
    expect(list.total).toBe(3);
  });

  it('不能停用或删除自己', async () => {
    const session = await login('admin', MOCK_PASSWORD);
    await expect(updateAccount(session.account.id, { status: 'disabled' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(deleteAccount(session.account.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('权限矩阵包含三种角色', async () => {
    const matrix = await getPermissionMatrix();
    expect(matrix.roles.map((role) => role.role)).toEqual(['admin', 'supervisor', 'viewer']);
    expect(matrix.roles[0].permissions).toContain('*');
  });

  it('审计筛选、导出 CSV 带 BOM 并记录导出动作', async () => {
    const all = await listAudit();
    expect(all.total).toBe(12);

    const systemOnly = await listAudit({ actorType: 'system' });
    expect(systemOnly.items.every((event) => event.actorType === 'system')).toBe(true);

    const csv = await exportAuditCsv({ result: 'success' });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('时间');
    expect(csv).toContain('draft.push');

    const after = await listAudit();
    expect(after.total).toBe(13);
    expect(after.items[0].action).toBe('audit.export');
  });

  it('机器人长连接断开后状态转红', async () => {
    const normal = await getWecomStatus();
    expect(normal.bot.status).toBe('green');

    setMockBotConnected(false);
    const broken = await getWecomStatus();
    expect(broken.bot.status).toBe('red');
    expect(broken.bot.message).toContain('断开');
    setMockBotConnected(true);
  });
});

describe('示例数据集自洽', () => {
  it('趋势、顾问、结果、客户四方数字一致', () => {
    expect(SAMPLE_TOTALS.volume).toBe(420);
    expect(SAMPLE_TOTALS.verified).toBe(356);

    const advisorVolume = SAMPLE_ADVISORS.reduce((sum, advisor) => sum + advisor.volume, 0);
    const advisorOutcomes = SAMPLE_ADVISORS.reduce(
      (sum, advisor) => sum + advisor.verified + advisor.editSent + advisor.misroute + advisor.unverified,
      0,
    );
    expect(advisorVolume).toBe(SAMPLE_TOTALS.volume);
    expect(advisorOutcomes).toBe(SAMPLE_TOTALS.volume);

    expect(SAMPLE_OUTCOMES.reduce((sum, item) => sum + item.count, 0)).toBe(SAMPLE_TOTALS.volume);
    expect(SAMPLE_TOTALS.messages).toBe(SAMPLE_TOTALS.volume);
    expect(SAMPLE_TOTALS.patients).toBe(12);
    expect(SAMPLE_TOTALS.advisors).toBe(3);
    expect(SAMPLE_AVG_RESPONSE_SECONDS).toBe(83);
  });
});
