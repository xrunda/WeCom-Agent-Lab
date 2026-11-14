import test from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeQueryService } from '../plugins/zhiban-wecom/knowledge-query.ts';
import type {
  ExplainableDraft,
  QueryableKnowledge,
  StaffRedlineExplain,
} from '../plugins/zhiban-wecom/knowledge-query.ts';

const RECORDS: QueryableKnowledge[] = [
  {
    id: 'kb_001',
    category: '饮食',
    title: '减重期晚餐怎么搭',
    content: '晚餐建议一半蔬菜、四分之一蛋白质、四分之一主食，少油少盐。',
  },
  {
    id: 'kb_002',
    category: '饮食',
    title: '加餐怎么选',
    content: '加餐优先选择无糖酸奶、少量坚果或低糖水果，避免含糖饮料。',
  },
  {
    id: 'kb_003',
    category: '随访',
    title: '复诊前要准备什么',
    content: '复诊前一周记录饮食和体重，带上最近的检查报告。',
  },
  {
    id: 'kb_004',
    category: '饮食',
    title: '外卖点餐建议',
    content: '优先清蒸、白灼，主食减半，酱汁单独放。',
  },
  {
    id: 'kb_005',
    category: '饮食',
    title: '停用条目',
    content: '这条已经停用，不应出现在结果里。',
    enabled: false,
  },
  {
    id: 'kb_006',
    category: '运动',
    title: '已删除条目',
    content: '这条已经删除。',
    deletedAt: 1,
  },
];

function setup(options: { draft?: ExplainableDraft; redline?: StaffRedlineExplain } = {}) {
  const now = { value: Date.UTC(2026, 10, 11, 2) };
  const service = new KnowledgeQueryService({
    source: () => ({ list: () => RECORDS }),
    latestDraft: (userId) => (userId === 'wang.guwen' ? options.draft : undefined),
    staffRedline: (userId) => (userId === 'wang.guwen' ? options.redline : undefined),
    now: () => now.value,
  });
  return { service, now };
}

test('#162 「帮助」列出可用指令，且不会被当成检索', () => {
  const { service } = setup();
  const text = service.reply('wang.guwen', '帮助') ?? '';
  assert.match(text, /知识 关键词/);
  assert.match(text, /为什么高风险/);
  assert.match(text, /话术/);
  assert.match(text, /只回复你本人/);
  assert.equal(service.reply('wang.guwen', '今天晚餐吃什么'), undefined);
});

test('#162 「知识 关键词」最多 3 条，只列启用的条目摘要', () => {
  const { service } = setup();
  const text = service.reply('wang.guwen', '知识 饮食') ?? '';
  assert.match(text, /找到 4 条/);
  assert.match(text, /减重期晚餐怎么搭/);
  assert.match(text, /加餐怎么选/);
  assert.match(text, /外卖点餐建议/);
  assert.equal(text.includes('停用条目'), false);
  assert.equal(text.includes('已删除条目'), false);
  assert.equal(text.includes('这条已经停用'), false);
  assert.match(text, /发「知识 1」查看全文/);
  // 只显示前 3 条
  assert.equal((text.match(/^\d\. /gm) ?? []).length, 3);
});

test('#162 看过列表后发编号取全文，30 分钟后失效', () => {
  const { service, now } = setup();
  service.reply('wang.guwen', '知识 饮食');
  const detail = service.replyToSelection('wang.guwen', '1') ?? '';
  assert.match(detail, /【减重期晚餐怎么搭】饮食/);
  assert.match(detail, /少油少盐/);
  assert.match(detail, /来源：知识库条目 kb_001/);
  assert.match(detail, /不构成新的医疗建议/);

  now.value += 31 * 60_000;
  assert.equal(service.replyToSelection('wang.guwen', '1'), undefined);
});

test('#162 编号越界与没有检索上下文时给出可执行提示', () => {
  const { service } = setup();
  assert.match(service.reply('wang.guwen', '知识 1') ?? '', /上次检索结果里没有第 1 条/);
  service.reply('wang.guwen', '知识 饮食');
  assert.match(service.replyToSelection('wang.guwen', '9') ?? '', /没有第 9 条/);
  assert.equal(service.replyToSelection('wang.guwen', '今天吃什么'), undefined);
});

test('#162 关键词 + 编号直接取对应结果；知识库编号可直接查全文', () => {
  const { service } = setup();
  const second = service.reply('wang.guwen', '知识 饮食 2') ?? '';
  assert.match(second, /【加餐怎么选】/);

  const byId = service.reply('wang.guwen', '知识 kb_003') ?? '';
  assert.match(byId, /【复诊前要准备什么】/);
  assert.match(byId, /来源：知识库条目 kb_003/);
});

test('#162 无命中、无条目、知识库未接入都有明确回执', () => {
  const { service } = setup();
  assert.match(service.reply('wang.guwen', '知识 干细胞') ?? '', /没有找到与「干细胞」相关的条目/);

  const empty = new KnowledgeQueryService({
    source: () => ({ list: () => [] }),
    latestDraft: () => undefined,
  });
  assert.match(empty.reply('wang.guwen', '知识 饮食') ?? '', /知识库还没有内容/);

  const missing = new KnowledgeQueryService({
    source: () => undefined,
    latestDraft: () => undefined,
  });
  assert.match(missing.reply('wang.guwen', '知识 饮食') ?? '', /知识库还没接入/);

  const overview = service.reply('wang.guwen', '知识') ?? '';
  assert.match(overview, /知识库共 4 条/);
  assert.match(overview, /饮食/);
  assert.match(overview, /随访/);
});

test('#162 「为什么高风险」解释规则判定，不生成新的医疗建议', () => {
  const { service } = setup({
    draft: {
      id: 'D1',
      riskLevel: 'high',
      ruleNames: ['急症只引导就医', '不承诺疗效'],
    },
  });
  const text = service.reply('wang.guwen', '为什么高风险') ?? '';
  assert.match(text, /高风险/);
  assert.match(text, /命中规则：急症只引导就医、不承诺疗效/);
  assert.match(text, /目前只有规则名，没有原文命中片段/);
  assert.equal(text.includes('建议服用'), false);
});

test('#162 没有规则记录 / 没有草稿时说清楚原因', () => {
  const noRules = setup({ draft: { id: 'D1', riskLevel: 'medium' } });
  const medium = noRules.service.reply('wang.guwen', '解释草稿') ?? '';
  assert.match(medium, /中风险/);
  assert.match(medium, /没有命中规则记录/);

  const none = setup();
  assert.match(none.service.reply('wang.guwen', '为什么标红') ?? '', /没有待处理的草稿/);
});

test('#162 只查发问顾问自己的草稿', () => {
  const { service } = setup({
    draft: { id: 'D1', riskLevel: 'high', ruleNames: ['急症只引导就医'] },
  });
  assert.match(service.reply('other.user', '为什么高风险') ?? '', /没有待处理的草稿/);
});

test('#162 每分钟 20 条软上限，超出提示稍后再试', () => {
  const { service } = setup();
  for (let i = 0; i < 20; i += 1) {
    assert.match(service.reply('wang.guwen', '帮助') ?? '', /可用指令/);
  }
  assert.match(service.reply('wang.guwen', '帮助') ?? '', /请求太频繁/);
  // 另一位顾问不受影响
  assert.match(service.reply('other.user', '帮助') ?? '', /可用指令/);
});

test('#162 引用质检提醒后追问「为什么红线」也能解释，只报规则与关键词', () => {
  const { service } = setup({
    redline: { ruleNames: ['不诊断'], keywords: ['诊断', '确诊'] },
  });
  const quoted =
    '群「客户-汪女士-20261108」李光的发言命中规则：不诊断。发言内容：「粥不是完全不能喝……」为什么红线?';
  const text = service.reply('wang.guwen', quoted) ?? '';
  assert.match(text, /红线规则：不诊断/);
  assert.match(text, /触发关键词：诊断、确诊/);
  assert.match(text, /不会发送到客户群/);
  assert.match(text, /撤回或更正/);
  // 不回显发言原文
  assert.equal(text.includes('粥不是完全不能喝'), false);
});

test('#162 「为什么红线」没有质检记录时如实说明', () => {
  const { service } = setup();
  const text = service.reply('wang.guwen', '为什么红线?') ?? '';
  assert.match(text, /没有找到你最近的质检记录/);
});

test('#162 没有草稿但有质检记录时，「为什么高风险」指向「为什么红线」', () => {
  const { service } = setup({ redline: { ruleNames: ['不诊断'], keywords: ['诊断'] } });
  const text = service.reply('wang.guwen', '为什么高风险') ?? '';
  assert.match(text, /没有待处理的草稿/);
  assert.match(text, /为什么红线/);
});

test('#162 改稿句子以解释词结尾时不当成提问', () => {
  const { service } = setup({ draft: { id: 'draft_1', riskLevel: 'high', ruleNames: ['不诊断'] } });
  assert.equal(service.reply('wang.guwen', '把结尾改成为什么高风险'), undefined);
});

test('#162 帮助里列出待办、草稿与红线解释', () => {
  const { service } = setup();
  const text = service.reply('wang.guwen', '帮助') ?? '';
  assert.match(text, /我的待办/);
  assert.match(text, /我的草稿/);
  assert.match(text, /为什么红线/);
});
