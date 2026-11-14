import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPromises,
  formatDueAt,
  promiseId,
  promiseReminderLine,
  shanghaiDayStart,
} from '../src/c2/promises.ts';

/** 东八区 2026-11-11（周三）10:00；中国无夏令时，直接减 8 小时 */
const AT = Date.UTC(2026, 10, 11, 2, 0, 0);

function shanghai(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 10, day, hour - 8, minute)).toISOString();
}

function first(text: string) {
  const list = extractPromises(text, AT);
  assert.equal(list.length, 1, `应抽出一条：${text}`);
  return list[0]!;
}

test('#160 20 句虚构发言：只抽明确的承诺（9 条）', () => {
  const utterances: Array<{ text: string; expected: boolean }> = [
    { text: '张女士您好，我明天下午把新的餐单发给您。', expected: true },
    { text: '今晚我整理一下您的用餐记录。', expected: true },
    { text: '后天我给您回访。', expected: true },
    { text: '这周五我把方案确认好发群里。', expected: true },
    { text: '下周一我联系您约复诊。', expected: true },
    { text: '月底前我帮您申请退款。', expected: true },
    { text: '我3天后给您寄体检报告。', expected: true },
    { text: '我明天上午跟医生确认后回复您。', expected: true },
    { text: '周日我给您回访。', expected: true },
    { text: '我昨天已经发您了。', expected: false },
    { text: '明天要开会，没时间回复。', expected: false },
    { text: '你觉得明天吃什么？', expected: false },
    { text: '我不会明天发给您的。', expected: false },
    { text: '明天天气不错。', expected: false },
    { text: '麻烦您明天发我一下。', expected: false },
    { text: '今天已经跟客户确认过了。', expected: false },
    { text: '这个方案下周再讨论吧。', expected: false },
    { text: '我明天问一下营养师。', expected: false },
    { text: '明天我看看资料。', expected: false },
    { text: '下周有空再聊。', expected: false },
  ];

  const results = utterances.map((item) => extractPromises(item.text, AT).length > 0);
  const positive = results.filter(Boolean).length;

  for (let i = 0; i < utterances.length; i += 1) {
    assert.equal(results[i], utterances[i]!.expected, `判定不符：${utterances[i]!.text}`);
  }
  assert.ok(Math.abs(positive - 9) <= 1, `正例数量应在 8±1 内，实际 ${positive}`);
});

test('#160 时间词落到东八区 18:00（晚上 20:00），并生成可读标签', () => {
  assert.equal(first('我明天把餐单发给您。').dueAt, Date.parse(shanghai(12, 18)));
  assert.equal(first('今晚我整理一下用餐记录。').dueAt, Date.parse(shanghai(11, 20)));
  assert.equal(first('后天我给您回访。').dueAt, Date.parse(shanghai(13, 18)));
  assert.equal(first('这周五我把方案确认好发群里。').dueAt, Date.parse(shanghai(13, 18)));
  assert.equal(first('下周一我联系您约复诊。').dueAt, Date.parse(shanghai(16, 18)));
  assert.equal(first('月底前我帮您申请退款。').dueAt, Date.parse(shanghai(30, 18)));
  assert.equal(first('我3天后给您寄体检报告。').dueAt, Date.parse(shanghai(14, 18)));
  assert.equal(first('周日我给您回访。').dueAt, Date.parse(shanghai(15, 18)));

  assert.equal(first('我明天把餐单发给您。').dueLabel, '明天 11-12 18:00');
  assert.match(first('今晚我整理一下用餐记录。').dueLabel, /^今晚 11-11 20:00$/);
});

test('#160 一句话最多一条；多句分别记账', () => {
  const list = extractPromises('我明天把餐单发给您。后天我再回访一次。', AT);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.dueAt, Date.parse(shanghai(12, 18)));
  assert.equal(list[1]!.dueAt, Date.parse(shanghai(13, 18)));
});

test('#160 过长的原话被截断，提醒不携带整段聊天', () => {
  const text = `明天我给您整理${'一份很详细的饮食建议'.repeat(20)}`;
  const item = first(text);
  assert.ok(item.excerpt.length <= 120);
  assert.ok(item.excerpt.endsWith('…'));
});

test('#160 承诺 id 由 msgid + 句子序号稳定生成', () => {
  assert.equal(promiseId('msg_1', 0), promiseId('msg_1', 0));
  assert.notEqual(promiseId('msg_1', 0), promiseId('msg_1', 1));
  assert.notEqual(promiseId('msg_1', 0), promiseId('msg_2', 0));
  assert.match(promiseId('msg_1', 0), /^prom_/);
});

test('#160 提醒文案引用原话与群名，不改写', () => {
  const line = promiseReminderLine({
    groupName: '减重-张女士',
    dueLabel: '明天 11-12 18:00',
    excerpt: '我明天把餐单发给您',
  });
  assert.match(line, /减重-张女士/);
  assert.match(line, /明天 11-12 18:00/);
  assert.match(line, /你说过：我明天把餐单发给您/);
});

test('#160 东八区零点', () => {
  // 11-11 04:00 +08 的东八区自然日零点
  const early = Date.UTC(2026, 10, 10, 20, 0, 0);
  assert.equal(shanghaiDayStart(early), Date.UTC(2026, 10, 10, 16));
  assert.equal(formatDueAt(Date.parse(shanghai(12, 18))), '11-12 18:00');
});
