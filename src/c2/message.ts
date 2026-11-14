import type { CardPayload, Draft, TextPayload } from './types.ts';
import type { PromiseRecord } from './promises.ts';

export const BUTTON_ACTIONS = ['sent', 'skipped'] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

const RISK_LABEL: Record<Draft['riskLevel'], string> = {
  low: '低',
  medium: '中',
  high: '高',
};

/** #55：卡片上的图片类型标签；未知类型回退为「图片」 */
const MEDIA_KIND_LABEL: Record<string, string> = {
  image: '图片',
  meal: '餐食',
  report: '化验单 / 报告',
  medicine: '药品',
  other: '其他图片',
  voice: '语音',
  file: '文件',
  video: '视频',
};

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/** 员工看的是手机时钟（东八区），服务器日志是 UTC，卡片一律按东八区显示 */
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function shanghaiClock(ms: number): string {
  return TIME_FORMAT.format(ms);
}

/**
 * 按钮 key 形如 ack:<draftId>:<action>（v1）或 ack:<draftId>:v<n>:<action>（改稿后）。
 * draftId 不允许包含冒号（生成时保证）。旧版卡片没有版本段，按 v1 处理；
 * 改稿后版本段不匹配即判为过期卡片（#56）。
 */
export function buttonKey(draftId: string, action: ButtonAction, version?: number): string {
  if (version === undefined || version <= 1) return `ack:${draftId}:${action}`;
  return `ack:${draftId}:v${version}:${action}`;
}

export function parseButtonKey(
  key: string,
): { draftId: string; action: ButtonAction; version?: number } | null {
  const parts = key.split(':');
  if (parts.length === 3 && parts[0] === 'ack') {
    const action = parts[2] as ButtonAction;
    if (!BUTTON_ACTIONS.includes(action)) return null;
    return { draftId: parts[1], action };
  }
  if (parts.length === 4 && parts[0] === 'ack' && /^v[1-9]\d*$/.test(parts[2])) {
    const action = parts[3] as ButtonAction;
    if (!BUTTON_ACTIONS.includes(action)) return null;
    return { draftId: parts[1], action, version: Number(parts[2].slice(1)) };
  }
  return null;
}

/**
 * 第一条：上下文卡片。只放"这是给谁的、发到哪"，不放正文。
 *
 * 标题只放群名，一行说完就够员工认群；客户/时间/成员放在下面的行里，
 * 群名本身是「按成员拼出来的」时候不再重复列一遍成员。
 */
export function buildCard(draft: Draft, queueDepth: number): CardPayload {
  const ahead = Math.max(0, queueDepth - 1);
  const customer =
    draft.lastInboundAt === undefined
      ? draft.customerName
      : `${draft.customerName} · ${shanghaiClock(draft.lastInboundAt)}`;
  const showMembers =
    draft.groupNameSource !== 'members' &&
    draft.groupMembers !== undefined &&
    draft.groupMembers.length > 0;
  const version = draft.version ?? 1;
  const revised = version > 1;
  const hasMedia = (draft.mediaIds?.length ?? 0) > 0;
  const mediaKinds = draft.mediaKinds?.length ? draft.mediaKinds : ['image'];
  const mediaLabel = `客户发来图片 · ${mediaKinds
    .map((kind) => MEDIA_KIND_LABEL[kind] ?? '图片')
    .join('、')}`;
  return {
    msgtype: 'template_card',
    template_card: {
      card_type: 'button_interaction',
      // 平台要求非空且唯一；带上 createdAt 与版本，重启后 draft_1、改稿后 v2 也不会撞车
      task_id: `c2-${draft.id}-${draft.createdAt.toString(36)}-v${version}`.slice(0, 32),
      main_title: {
        title: revised ? `第 ${version} 版 · 待回复 · ${draft.groupName}` : `待回复 · ${draft.groupName}`,
        desc:
          revised && draft.revisionInstruction
            ? `按你的要求：${truncate(draft.revisionInstruction, 40)}`
            : ahead > 0
              ? `后面还有 ${ahead} 条`
              : '当前仅此一条',
      },
      sub_title_text: draft.fallback
        ? `模板草稿 · 客户原文：${truncate(draft.inboundSummary, 80)}`
        : `客户原文：${truncate(draft.inboundSummary, 80)}`,
      horizontal_content_list: [
        { keyname: '客户', value: truncate(customer, 60) },
        ...(hasMedia ? [{ keyname: '图片', value: truncate(mediaLabel, 60) }] : []),
        ...(showMembers
          ? [{ keyname: '群成员', value: truncate(draft.groupMembers!.join('、'), 60) }]
          : []),
        {
          keyname: '命中规则',
          value:
            draft.ruleNames && draft.ruleNames.length > 0
              ? draft.ruleNames.join('、')
              : draft.ruleIds.length > 0
                ? draft.ruleIds.join('、')
                : '无',
        },
        { keyname: '风险', value: RISK_LABEL[draft.riskLevel] },
        ...(draft.source === 'proactive' ? [{ keyname: '来源', value: 'Agent 主动' }] : []),
        ...(draft.fallback ? [{ keyname: '标记', value: '模板草稿' }] : []),
      ],
      button_list: [
        { text: '已发送', style: 1, key: buttonKey(draft.id, 'sent', version) },
        { text: '忽略', style: 4, key: buttonKey(draft.id, 'skipped', version) },
      ],
    },
  };
}

/** 等待时长的人类可读写法；用于「客户在等」聚合提醒 */
export function humanWait(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * #163 「客户在等」聚合提醒：只说有几个群、最久等了多久，不带正文。
 * 顾问收到后去侧边栏处理，内容不经过 1:1 通道。
 */
export function buildWaitingReminder(groups: number, oldestWaitMs: number): TextPayload {
  const count = Math.max(1, groups);
  return {
    msgtype: 'text',
    text: {
      content:
        `客户在等：${count} 个群有未处理消息，最久 ${humanWait(oldestWaitMs)}。` +
        '打开企微侧边栏查看并处理。',
    },
  };
}

/**
 * #160 承诺到期卡片：引用顾问自己的原话（这是唯一事实来源），
 * 不包含客户消息正文；按钮一次作用于卡片上列出的全部承诺。
 */
export function buildPromiseCard(items: PromiseRecord[], total = items.length): CardPayload {
  const shown = items.slice(0, 3);
  const ids = shown.map((item) => item.id).join(',');
  const title =
    shown.length === 1 ? `承诺到期 · ${shown[0]!.groupName}` : `承诺到期 · ${shown.length} 条`;
  const more = total > shown.length ? `另有 ${total - shown.length} 条，请在侧边栏查看` : '这些是你答应过客户的事';
  return {
    msgtype: 'template_card',
    template_card: {
      card_type: 'button_interaction',
      task_id: `pr-${ids.replace(/[^a-z0-9]/gi, '')}-${shown[0]?.dueAt.toString(36) ?? '0'}`.slice(0, 32),
      main_title: {
        title,
        desc: shown.length === 1 ? shown[0]!.dueLabel : '按到期时间排序',
      },
      sub_title_text: more,
      horizontal_content_list: shown.map((item) => ({
        keyname: truncate(item.groupName, 30),
        value: truncate(`${item.dueLabel} · ${item.excerpt}`, 80),
      })),
      button_list: [
        { text: '已处理', style: 1, key: `promise:${ids}:done` },
        { text: '稍后提醒', style: 2, key: `promise:${ids}:later` },
        { text: '这不是承诺', style: 4, key: `promise:${ids}:false` },
      ],
    },
  };
}

/**
 * #161 每日巡检卡片：最多 3 条信号，只写「哪个群、什么信号、多久」。
 * 「今天不看」只抑制当天同类推送，不改变数据。
 */
export function buildPatrolCard(
  advisorId: string,
  signals: Array<{ groupName: string; kind: 'silent' | 'complaint'; days: number }>,
  extraCount: number,
): CardPayload {
  const shown = signals.slice(0, 3);
  return {
    msgtype: 'template_card',
    template_card: {
      card_type: 'button_interaction',
      task_id: `pt-${advisorId}-${shanghaiClock(Date.now()).replace(':', '')}`.slice(0, 32),
      main_title: {
        title: `今日巡检 · ${shown.length} 个群需要关注`,
        desc: '只列群与信号，不展示客户消息',
      },
      sub_title_text:
        extraCount > 0
          ? `另有 ${extraCount} 条，打开侧边栏查看`
          : '打开侧边栏查看具体情况',
      horizontal_content_list: shown.map((signal) => ({
        keyname: truncate(signal.groupName, 30),
        value: signal.kind === 'complaint' ? '出现投诉/风险信号' : `客户已沉默 ${signal.days} 天`,
      })),
      button_list: [
        { text: '查看', style: 1, key: `patrol:${advisorId}:show` },
        { text: '今天不看', style: 4, key: `patrol:${advisorId}:mute` },
      ],
    },
  };
}

/**
 * 第二条：正文气泡。只含要发出去的内容，不拼接任何头部。
 * 员工长按复制这一条，不会把"发往 A 群"一起复制走。
 */
export function buildBody(draft: Draft): TextPayload {
  return { msgtype: 'text', text: { content: draft.body } };
}

export function buildDraftMessages(
  draft: Draft,
  queueDepth: number,
): { card: CardPayload; body: TextPayload } {
  return { card: buildCard(draft, queueDepth), body: buildBody(draft) };
}
