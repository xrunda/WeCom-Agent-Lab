import test from 'node:test';
import assert from 'node:assert/strict';

import { checkDraft } from '../eval/drafts/checks.ts';
import { buildSystemPrompt, buildTurnPrompt } from '../src/p1/persona.ts';
import type { EvalCase } from '../eval/drafts/types.ts';
import type { MergedInbound, Speaker } from '../src/p1/types.ts';

import { SETTINGS } from './p1-helpers.ts';

function merged(speaker: Speaker): MergedInbound {
  return {
    id: 'batch_1',
    roomId: 'wr_test',
    groupId: 'group_1',
    groupName: '客户群',
    patientId: 'p_1',
    advisorId: 'adv_1',
    messages: [
      {
        msgid: 'm_1',
        roomId: 'wr_test',
        from: speaker.id,
        text: '糖尿病餐食推荐',
        msgtime: 1_700_000_000_000,
      },
    ],
    speaker,
    source: 'inbound',
    mergedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
  };
}

const UNKNOWN: Speaker = {
  id: 'wm_1',
  displayName: '外部成员 9NfOsA',
  role: 'unknown',
  isExternal: true,
};

const SELF: Speaker = {
  id: 'wm_1',
  displayName: '王女士',
  role: 'self',
  isExternal: true,
};

test('系统提示词要求草稿正文可直接转发到客户群', () => {
  const prompt = buildSystemPrompt(SETTINGS);

  assert.match(prompt, /直接复制发到客户群/);
  assert.match(prompt, /不要出现「群里」/);
  assert.match(prompt, /不要写「家属说」「群里有人提到」/);
  assert.match(prompt, /500 字以内/);
  // 旧规则要求把来源写进正文，正是「群里有人问到」的来源
  assert.doesNotMatch(prompt, /引用时要写明/);
});

test('身份未知的发言人：用自然提问核实，不把来源写进正文', () => {
  const prompt = buildTurnPrompt(merged(UNKNOWN), SETTINGS);

  assert.match(prompt, /请问是您本人还是家属/);
  assert.match(prompt, /不要写「家属说」「群里有人提到」/);
  assert.doesNotMatch(prompt, /必要时在草稿里写明来源/);
});

test('本人发言不追加来源提醒', () => {
  const prompt = buildTurnPrompt(merged(SELF), SETTINGS);

  assert.doesNotMatch(prompt, /写明来源|群里有人提到/);
});

test('评测规则：正文出现「群里有人问到」判为不可直接转发', () => {
  const testCase: EvalCase = {
    id: 'text-forwardable',
    kind: 'text',
    category: 'family',
    message: '',
    expectedPoints: [],
    forbidden: [],
    maxChars: 500,
  };

  const bad = checkDraft({
    testCase,
    body: '您好，群里有人问到糖尿病餐食推荐，先按一般原则给您一份参考。',
  });
  assert.equal(bad.pass, false);
  assert.ok(bad.violations.some((item) => item.includes('内部视角')));

  const good = checkDraft({
    testCase,
    body: '您好，糖尿病饮食可以先按这些原则来：主食定量、粗细搭配，多吃蔬菜，蛋白质选鱼、蛋和豆制品。',
  });
  assert.equal(good.pass, true);
});
