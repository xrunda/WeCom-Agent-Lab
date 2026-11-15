import test from 'node:test';
import assert from 'node:assert/strict';

import { splitByKeywords, splitStaffQuote } from '../console/src/pages/alerts/alert-text.ts';

test('告警正文拆引文：只认「发言内容：」后的引号，群名里的「」不算', () => {
  const message =
    '群「客户-汪女士-20261108」李光的发言命中规则：不诊断。发言内容：「粥不是完全不能喝，关键看是什么粥。」';
  const parts = splitStaffQuote(message);
  assert.equal(parts.before, '群「客户-汪女士-20261108」李光的发言命中规则：不诊断。发言内容：「');
  assert.equal(parts.quote, '粥不是完全不能喝，关键看是什么粥。');
  assert.equal(parts.after, '」');
});

test('告警正文拆引文：没有引文时原样返回', () => {
  const message = '草稿发到了「减重-刘先生」';
  const parts = splitStaffQuote(message);
  assert.equal(parts.before, message);
  assert.equal(parts.quote, undefined);
  assert.equal(parts.after, '');
});

test('关键词高亮：标出所有命中，长词优先，相邻命中合并', () => {
  const segments = splitByKeywords('建议去医院确诊一下，但不能自己诊断。', ['诊断', '确诊']);
  assert.deepEqual(segments, [
    { text: '建议去医院', hit: false },
    { text: '确诊', hit: true },
    { text: '一下，但不能自己', hit: false },
    { text: '诊断', hit: true },
    { text: '。', hit: false },
  ]);
});

test('关键词高亮：英文大小写不敏感，相同词只算一次', () => {
  const segments = splitByKeywords('复查 HbA1c 和 hba1c', ['HbA1c', 'HbA1c']);
  assert.deepEqual(segments, [
    { text: '复查 ', hit: false },
    { text: 'HbA1c', hit: true },
    { text: ' 和 ', hit: false },
    { text: 'hba1c', hit: true },
  ]);
});

test('关键词高亮：没有关键词或空文本时原样返回', () => {
  assert.deepEqual(splitByKeywords('一句话', []), [{ text: '一句话', hit: false }]);
  assert.deepEqual(splitByKeywords('', ['诊断']), [{ text: '', hit: false }]);
  // 关键词全是空白也不高亮
  assert.deepEqual(splitByKeywords('一句话', ['  ']), [{ text: '一句话', hit: false }]);
});
