/**
 * 演示内容生成脚本（一次性使用）。
 *
 * 用真实 ContentService 走「创建 → 提交审核 → 发布」，保证写进存储的记录
 * 满足 validateArticle 的全部规则（出处、逐字核对、食材安全、无疗效宣称）。
 * 运行后输出已发布记录的 JSON，由部署侧灌进 zhiban_patient_h5.json。
 *
 * 全部为虚构演示内容；引用均为公有领域古籍原文。
 */
import { ContentService, MemoryContentBackend } from '../src/p1/patient-h5-content.ts';
import type { ContentArticle } from '../src/p1/patient-h5-content.ts';
import { idFactory } from '../src/p1/ids.ts';

const ASSET = (name: string): string => `/h5/assets/${name}`;

const backend = new MemoryContentBackend();
const service = new ContentService({
  tenantId: 'tn_zhiban_demo',
  backend,
  ids: idFactory(() => Date.now()),
  now: () => Date.now(),
});

interface Draft {
  category: 'classics_life' | 'ingredients' | 'seasonal_living';
  title: string;
  summary: string;
  cover: string;
  scenarioTags: string[];
  seasonTerm?: string;
  ingredientSafety?: { usage: string; conditions: string; cautions: string };
  sections: Array<{ kind: 'classic_quote' | 'plain_explanation' | 'modern_life' | 'practice' | 'brand_copy'; text: string; citation?: string; verified?: boolean }>;
}

const DRAFTS: Draft[] = [
  {
    category: 'classics_life',
    title: '早餐，怎样吃得更丰富？',
    summary: '几种家常搭配思路，让早餐更均衡、也更合口味。',
    cover: ASSET('meal-square.jpg'),
    scenarioTags: ['早餐', '规律饮食'],
    sections: [
      {
        kind: 'classic_quote',
        text: '五谷为养，五果为助，五畜为益，五菜为充。',
        citation: '《黄帝内经·素问·脏气法时论》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '主食打底，果、菜、肉蛋帮衬。一顿早餐只要有三样，就已经比只有一样强很多。',
      },
      {
        kind: 'modern_life',
        text: '一碗粥、一个鸡蛋、一小碟青菜，是很常见也不会出错的样子。赶时间的话，粥可以前一晚用电饭煲定好。',
      },
      { kind: 'practice', text: '明天早餐加一种蔬菜，比如番茄或小青菜。' },
    ],
  },
  {
    category: 'seasonal_living',
    title: '睡得浅的时候，晚餐可以做点什么',
    summary: '从晚饭的时间和分量说起，聊聊睡前那几小时。',
    cover: ASSET('article-fish.jpg'),
    scenarioTags: ['睡眠', '晚餐'],
    seasonTerm: '大雪',
    sections: [
      {
        kind: 'classic_quote',
        text: '胃不和则卧不安。',
        citation: '《黄帝内经·素问·逆调论》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '晚上吃得过饱、过晚，躺下时肠胃还在忙，人就容易睡不沉。古人这句话讲的就是这层意思。',
      },
      {
        kind: 'modern_life',
        text: '把晚饭和睡觉之间留出两三个小时，是很多人的经验。晚饭清淡一点、少喝汤水，夜里起夜的次数也会少些。',
      },
      { kind: 'practice', text: '今晚睡前两小时不再吃东西。' },
    ],
  },
  {
    category: 'ingredients',
    title: '认识食材：小米',
    summary: '家常小米的日常吃法、适用条件与注意事项。',
    cover: ASSET('article-millet.jpg'),
    scenarioTags: ['早餐', '肠胃'],
    ingredientSafety: {
      usage: '煮粥最常见，也可以和大米、南瓜一起同煮；煮前淘洗两遍即可，不用反复搓。',
      conditions: '日常主食之一，早餐、晚餐都合适；胃口一般、想吃软一点的时候更容易入口。',
      cautions: '血糖偏高的人注意总量，不要单独喝一大碗粥；粥煮得越烂，越要配点菜和蛋白质一起吃。',
    },
    sections: [
      {
        kind: 'classic_quote',
        text: '煮粥食，益丹田，补虚损，开肠胃。',
        citation: '《本草纲目·谷部·粟米》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '李时珍记的是古人拿小米煮粥当日常吃食的经验，讲的是它好入口、宜常吃。',
      },
      {
        kind: 'modern_life',
        text: '北方人家的早饭常有一碗小米粥。单喝粥容易饿，配一个鸡蛋或一小碟咸菜，就是完整的一顿。',
      },
      { kind: 'practice', text: '晚饭用小米粥替一半白米饭。' },
    ],
  },
  {
    category: 'seasonal_living',
    title: '天冷了，一碗热汤面的分寸',
    summary: '热汤暖身，也别贪多，看看分量与搭配。',
    cover: ASSET('article-noodles.jpg'),
    scenarioTags: ['冬季', '午餐'],
    seasonTerm: '小雪',
    sections: [
      {
        kind: 'classic_quote',
        text: '食饮有节。',
        citation: '《黄帝内经·素问·上古天真论》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '「有节」不是吃得少，而是有分寸：定时、定量，不因为好吃就一次吃撑。',
      },
      {
        kind: 'modern_life',
        text: '热汤面在冷天很受欢迎。面多汤咸，一碗下去容易盐和主食都超量；配一小碟青菜，汤喝一半，就轻快很多。',
      },
      { kind: 'practice', text: '吃面时配一小碟青菜，汤别喝完。' },
    ],
  },
  {
    category: 'classics_life',
    title: '食饮有节：一顿饭吃多少算合适',
    summary: '不用称重，用手和碗就能估出大概的分量。',
    cover: ASSET('meal-hero.jpg'),
    scenarioTags: ['体重', '规律饮食'],
    sections: [
      {
        kind: 'classic_quote',
        text: '食饮有节，起居有常，不妄作劳。',
        citation: '《黄帝内经·素问·上古天真论》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '古人把「吃得有节制」和「作息有规律」放在一起讲，讲的是日常习惯，不是一时的忌口。',
      },
      {
        kind: 'modern_life',
        text: '一个简单的估法：主食一拳头、蔬菜两拳头、蛋白质一掌心。吃到七八分饱，放下筷子还能再吃两口，就是刚好的量。',
      },
      { kind: 'practice', text: '今晚吃饭时，先盛七分满。' },
    ],
  },
  {
    category: 'ingredients',
    title: '认识食材：山药',
    summary: '山药的挑选、做法与去皮时的小麻烦。',
    cover: ASSET('meal-square.jpg'),
    scenarioTags: ['肠胃', '加餐'],
    ingredientSafety: {
      usage: '蒸、煮粥、炖汤都常见；蒸熟后压成泥，牙口不好的人也好入口。',
      conditions: '日常蔬菜之一，可以当加餐；想少吃点点心的时候，蒸一段山药是不错的替代。',
      cautions: '生山药黏液沾到手上容易发痒，削皮时戴一次性手套；切好后泡在清水里防氧化发黑。',
    },
    sections: [
      {
        kind: 'classic_quote',
        text: '薯蓣，味甘温。主伤中，补虚羸，除寒热邪气，补中，益气力，长肌肉。',
        citation: '《神农本草经·上品·薯蓣》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '薯蓣就是今天的山药。这段是古人对它的记载，属于传统认识，不是现代医学结论。',
      },
      {
        kind: 'modern_life',
        text: '菜市场里挑山药，看表皮完整、须根少、掂着沉。铁棍山药细长、口感粉；菜山药粗、水分多，适合炒。',
      },
      { kind: 'practice', text: '蒸一段山药当下午加餐，代替饼干点心。' },
    ],
  },
  {
    category: 'seasonal_living',
    title: '冬日早睡晚起，从作息说起',
    summary: '冬天昼短夜长，作息也可以跟着松一点。',
    cover: ASSET('meal-hero.jpg'),
    scenarioTags: ['睡眠', '冬季'],
    seasonTerm: '冬至',
    sections: [
      {
        kind: 'classic_quote',
        text: '冬三月，此谓闭藏……早卧晚起，必待日光。',
        citation: '《黄帝内经·素问·四气调神大论》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '古人讲冬天要「藏」：早点睡，等太阳出来再起。放到今天，就是别在冬天硬撑着熬夜、天不亮就出门。',
      },
      {
        kind: 'modern_life',
        text: '天冷时血管收缩，清早起床动作急容易头晕。醒来先在床上躺一会儿，坐起来缓一缓再下地，是对老人最实用的一条。',
      },
      { kind: 'practice', text: '这个月试着比平时早半小时睡。' },
    ],
  },
  {
    category: 'ingredients',
    title: '认识食材：白萝卜',
    summary: '冬天的白萝卜怎么挑、怎么炖更入味。',
    cover: ASSET('article-noodles.jpg'),
    scenarioTags: ['冬季', '家常菜'],
    ingredientSafety: {
      usage: '炖肉、煮汤、凉拌都常见；切块后先用清水泡一会儿，辛辣味会淡一些。',
      conditions: '日常蔬菜之一，冬天正当季，价格也便宜。',
      cautions: '脾胃怕凉、容易腹泻的人少吃生萝卜；正在服用中药的人，按医嘱安排饮食。',
    },
    sections: [
      {
        kind: 'classic_quote',
        text: '根叶皆可生可熟……乃蔬中之最有利益者。',
        citation: '《本草纲目·菜部·莱菔》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '莱菔就是萝卜。李时珍说的是它做法多、四季都能吃，是菜里最实惠的一样。',
      },
      {
        kind: 'modern_life',
        text: '挑萝卜看三点：掂着沉、表皮光滑、根须少。炖肉时放几块，汤会带一点甜，盐可以少放一勺。',
      },
      { kind: 'practice', text: '炖肉时放几块白萝卜，少放一勺盐。' },
    ],
  },
  {
    category: 'classics_life',
    title: '粥能益人：老人早饭的一碗粥',
    summary: '一碗粥怎么煮、配什么，才不只是「喝个水饱」。',
    cover: ASSET('article-millet.jpg'),
    scenarioTags: ['早餐', '肠胃'],
    sections: [
      {
        kind: 'classic_quote',
        text: '粥能益人，老年尤宜。',
        citation: '《老老恒言·饮食》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '清代曹庭栋专写养老的书里，把粥放在很靠前的位置：软、热、好入口，对牙口不好的人尤其合适。',
      },
      {
        kind: 'modern_life',
        text: '只喝白粥容易饿。粥里加一把燕麦、小米或红豆，再配一个鸡蛋，饱腹感能撑到中午。',
      },
      { kind: 'practice', text: '早饭的粥里加一把燕麦或小米。' },
    ],
  },
  {
    category: 'seasonal_living',
    title: '不时不食：跟着节气挑菜',
    summary: '当季的菜便宜、好吃，也省得为挑什么发愁。',
    cover: ASSET('meal-square.jpg'),
    scenarioTags: ['规律饮食', '四季'],
    seasonTerm: '大雪',
    sections: [
      {
        kind: 'classic_quote',
        text: '不时不食。',
        citation: '《论语·乡党》',
        verified: true,
      },
      {
        kind: 'plain_explanation',
        text: '孔子这句话，讲的是不吃不当季的东西。放到今天，就是买菜先看当季。',
      },
      {
        kind: 'modern_life',
        text: '冬天常见的是白菜、萝卜、菠菜、冬笋；夏天的番茄、黄瓜，冬天大棚里也有，但味道和价格都不一样。跟着节气买，菜篮子和钱包都轻松。',
      },
      { kind: 'practice', text: '这周买菜时挑一样当季的菜。' },
    ],
  },
];

const published: ContentArticle[] = [];
for (const draft of DRAFTS) {
  const created = await service.create({
    category: draft.category,
    title: draft.title,
    summary: draft.summary,
    sections: draft.sections,
    coverUrl: draft.cover,
    authorType: 'editor',
    authorName: '知伴编辑部（演示）',
    scenarioTags: draft.scenarioTags,
    ...(draft.seasonTerm ? { seasonTerm: draft.seasonTerm } : {}),
    ...(draft.ingredientSafety ? { ingredientSafety: draft.ingredientSafety } : {}),
    actorId: 'acc_demo_editor',
  });
  await service.submitReview({ id: created.id, actorId: 'acc_demo_editor' });
  const done = await service.publish({
    id: created.id,
    reviewerAccountId: 'acc_mwa0ynpv583d9fea322a',
    reviewerName: '机构管理员（演示审核）',
  });
  published.push(done);
}

process.stdout.write(JSON.stringify(published, null, 2));
