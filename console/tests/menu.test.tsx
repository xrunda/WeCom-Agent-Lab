import { describe, expect, it } from 'vitest';

import { buildMenuItems, buildPageMeta } from '../src/layout/menu.tsx';
import type { MenuDataItem } from '@ant-design/pro-components';

function flatten(items: MenuDataItem[]): MenuDataItem[] {
  return items.flatMap((item) => [item, ...(item.children ? flatten(item.children) : [])]);
}

describe('控制台菜单与页面元数据', () => {
  it('称谓变化时菜单同步变化', () => {
    const patientItem = buildMenuItems('会员').find((item) => item.path === '/patients');
    expect(patientItem?.name).toBe('会员 Agent');
    expect(buildMenuItems('客户').find((item) => item.path === '/patients')?.name).toBe(
      '客户 Agent',
    );
  });

  it('覆盖 P1-scope §4 的全部入口', () => {
    const paths = flatten(buildMenuItems('患者'))
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path));

    expect(paths).toEqual(
      expect.arrayContaining([
        '/dashboard',
        '/patients',
        '/service-flow',
        '/sandbox',
        '/alerts',
        '/groups',
        '/checkins',
        '/advisors',
        '/shifts',
        '/knowledge',
        '/rules',
        '/scripts',
        '/reports',
        '/solutions',
        '/settings/agent',
        '/settings/wecom',
        '/settings/model',
        '/settings/accounts',
        '/settings/audit',
        '/settings/security',
        '/settings/onboarding',
      ]),
    );
  });

  it('技能市场不再作为导航入口', () => {
    const paths = flatten(buildMenuItems('患者'))
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path));

    expect(paths).not.toContain('/skills');
  });

  it('C 档入口带「即将上线」角标', () => {
    const cPaths = buildPageMeta('患者')
      .filter((page) => page.tier === 'C')
      .map((page) => page.path);

    expect(cPaths).toEqual(expect.arrayContaining(['/checkins', '/shifts']));
  });
});
