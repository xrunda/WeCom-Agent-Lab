import { beforeEach, describe, expect, it } from 'vitest';

import {
  listAdvisors,
  pauseAdvisor,
  resetAdvisorsMock,
  resumeAdvisor,
  samplePerformance,
  seatCost,
} from '../src/mock/advisors.ts';

beforeEach(() => {
  resetAdvisorsMock();
});

describe('顾问 mock 数据', () => {
  it('席位成本随席位数变化', async () => {
    const advisors = await listAdvisors();
    expect(seatCost(advisors, 900)).toEqual({ seats: 3, pricePerSeat: 900, annualCost: 2700 });
    expect(seatCost(advisors.slice(0, 2), 1200)).toMatchObject({ seats: 2, annualCost: 2400 });
  });

  it('暂停后离线，恢复后清零错群计数', async () => {
    const paused = await pauseAdvisor('adv_01');
    expect(paused).toMatchObject({ status: 'paused', online: false });
    expect(paused.pausedAt).toBeTypeOf('number');

    const resumed = await resumeAdvisor('adv_01');
    expect(resumed).toMatchObject({
      status: 'active',
      pausedAt: null,
      consecutiveMisroutes: 0,
    });
  });

  it('按状态筛选', async () => {
    const paused = await listAdvisors('paused');
    expect(paused.map((item) => item.id)).toEqual(['adv_03']);
  });

  it('绩效数据固定标记为示例', async () => {
    const rows = samplePerformance(await listAdvisors());
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.sample)).toBe(true);
  });
});
