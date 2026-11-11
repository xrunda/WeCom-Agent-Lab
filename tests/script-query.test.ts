import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isScriptQuery,
  ScriptQueryService,
  splitForWecom,
} from '../plugins/zhiban-wecom/script-query.ts';
import type { QueryableScript } from '../plugins/zhiban-wecom/script-query.ts';

const SCRIPTS: QueryableScript[] = [
  {
    id: 'scr_1',
    category: '复诊',
    title: '复诊前提醒',
    content: '明天上午复诊，请带上最近的检查报告。',
    tags: ['提醒'],
  },
  {
    id: 'scr_2',
    category: '饮食',
    title: '晚餐建议',
    content: '晚餐尽量安排在 19 点前，主食控制在一个拳头大小。',
    tags: ['晚餐'],
  },
  {
    id: 'scr_3',
    category: '饮食',
    title: '加餐建议',
    content: '两餐之间可以加一小盒无糖酸奶或几块豆腐干。',
    tags: ['加餐'],
  },
  {
    id: 'scr_4',
    category: '复诊',
    title: '复诊前饮食记录',
    content: '复诊前把最近两周的饮食情况简单记下来。',
    tags: ['复诊'],
  },
];

function service(scripts: QueryableScript[] = SCRIPTS, now = () => 1_000_000) {
  return new ScriptQueryService(() => ({ listEnabled: () => scripts }), now);
}

test('只有「话术」开头的 1:1 文本才进入查询，其余交给改稿流程', () => {
  assert.equal(isScriptQuery('话术'), true);
  assert.equal(isScriptQuery('话术 复诊'), true);
  assert.equal(isScriptQuery('话术复诊'), true);
  assert.equal(isScriptQuery('帮我改短一点'), false);
  assert.equal(service().reply('u1', '帮我改短一点'), undefined);
});

test('不带关键词时展示分类与用法，并说明只回复本人', () => {
  const reply = service().reply('u1', '话术')!;
  assert.match(reply, /共 4 条/);
  assert.match(reply, /复诊 2/);
  assert.match(reply, /饮食 2/);
  assert.match(reply, /话术 关键词/);
  assert.match(reply, /不会把这些话术发到客户群/);
});

test('按标题 / 分类 / 标签 / 正文搜索，编号后可取全文', () => {
  const query = service();

  const byTitle = query.reply('u1', '话术 加餐')!;
  assert.match(byTitle, /1\. 加餐建议（饮食）/);
  assert.match(byTitle, /回复「话术 1」查看全文/);

  const detail = query.reply('u1', '话术 1')!;
  assert.match(detail, /【加餐建议】饮食 · 标签：加餐/);
  assert.match(detail, /无糖酸奶/);
  assert.match(detail, /机器人不会自动发送/);

  // 分类与正文同样可命中
  assert.match(query.reply('u2', '话术 复诊')!, /复诊前提醒/);
  assert.match(query.reply('u3', '话术 检查报告')!, /复诊前提醒/);
});

test('分类名精确查询不再混入正文命中，支持「关键词 + 编号」一步取全文', () => {
  const query = service();

  const list = query.reply('u1', '话术 饮食')!;
  assert.match(list, /找到 2 条话术/);
  assert.doesNotMatch(list, /复诊前饮食记录/);

  // 「话术 饮食 1」直接返回第 1 条全文（按标题排序：加餐建议在前）
  const direct = query.reply('u2', '话术 饮食 1')!;
  assert.match(direct, /【加餐建议】/);
  assert.match(direct, /无糖酸奶/);

  // 中文冒号、逗号同样能分隔编号
  assert.match(query.reply('u3', '话术 饮食：2')!, /【晚餐建议】/);
  assert.match(query.reply('u4', '话术 饮食，2')!, /【晚餐建议】/);

  // 编号超出范围有明确提示
  assert.match(query.reply('u5', '话术 饮食 9')!, /只有 2 条，没有第 9 条/);
});

test('看过列表后直接发数字取全文；没有搜索结果时不劫持改稿', () => {
  const query = service();
  assert.equal(query.replyToSelection('u1', '1'), undefined);

  query.reply('u1', '话术 饮食');
  assert.match(query.replyToSelection('u1', '2')!, /【晚餐建议】/);
  assert.match(query.replyToSelection('u1', '9')!, /没有第 9 条/);

  // 非纯数字文本与另一个用户都不处理
  assert.equal(query.replyToSelection('u1', '语气温和一点'), undefined);
  assert.equal(query.replyToSelection('u2', '1'), undefined);
});

test('关键词里的数字不被误当编号（如维生素B12）', () => {
  const scripts: QueryableScript[] = [
    { id: 's1', category: '用药', title: '维生素B12 补充', content: '按医嘱补充。' },
    { id: 's2', category: '用药', title: '维生素C', content: '多吃新鲜蔬果。' },
  ];
  const reply = service(scripts).reply('u1', '话术 维生素B12')!;
  assert.match(reply, /维生素B12 补充/);
  assert.doesNotMatch(reply, /第 12 条/);
});

test('编号结果按用户隔离，30 分钟后过期', () => {
  let now = 1_000_000;
  const query = new ScriptQueryService(
    () => ({ listEnabled: () => SCRIPTS }),
    () => now,
  );

  query.reply('u1', '话术 饮食');
  assert.match(query.reply('u1', '话术 1')!, /晚餐建议|加餐建议/);
  // 另一个用户没有搜索结果
  assert.match(query.reply('u2', '话术 1')!, /没有第 1 条/);

  now += 30 * 60_000 + 1;
  assert.match(query.reply('u1', '话术 1')!, /没有第 1 条/);
});

test('没有匹配、空库、未接入都有明确提示', () => {
  assert.match(service().reply('u1', '话术 不存在的词')!, /没找到与「不存在的词」匹配的话术/);
  assert.match(service([]).reply('u1', '话术')!, /还没有内容/);
  const missing = new ScriptQueryService(() => undefined);
  assert.match(missing.reply('u1', '话术 复诊')!, /还没接入/);
});

test('长话术按字节拆成多条，不丢字符且每条不超过上限', () => {
  const paragraph = '这是一段很长的复诊提醒正文，用于验证按字节切分不会丢字。\n';
  const text = `【复诊提醒】复诊\n\n${paragraph.repeat(40)}\n复制后粘贴到客户群发送。`;
  const chunks = splitForWecom(text, 2000);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 2000);
  }
  // 单条以内不拆分，空串不产生消息
  assert.deepEqual(splitForWecom('短话术', 2000), ['短话术']);
  assert.deepEqual(splitForWecom('', 2000), []);
});
