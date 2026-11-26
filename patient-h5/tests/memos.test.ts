/**
 * 日历备忘：本机存储、按日查询、删除。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { addMemo, loadMemos, memosOn, removeMemo } from '../src/utils/memos.ts';

beforeEach(() => {
  window.localStorage.clear();
});

describe('日历备忘', () => {
  it('保存后可按日期取回', () => {
    addMemo({ date: '2026-12-01', type: 'birthday', title: '母亲生日' });
    const list = loadMemos();
    expect(list).toHaveLength(1);
    expect(memosOn(list, '2026-12-01')[0]?.title).toBe('母亲生日');
    expect(memosOn(list, '2026-12-02')).toHaveLength(0);
  });

  it('可以删除', () => {
    const memo = addMemo({ date: '2026-12-01', type: 'memorial', title: '忌日' });
    removeMemo(memo.id);
    expect(loadMemos()).toHaveLength(0);
  });

  it('标题超长时截断，空白标题也存下去但不带空格', () => {
    const memo = addMemo({ date: '2026-12-01', type: 'other', title: `  ${'长'.repeat(40)}  ` });
    expect(memo.title.length).toBe(30);
  });
});
