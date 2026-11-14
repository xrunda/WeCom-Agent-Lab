/**
 * 侧边栏渲染（#148）。
 *
 * 两张卡片：待回复、客户速览。全部动态文本先转义；交互用事件委托，
 * 状态只存在页面内存，切会话重新拉取。
 */
import { copyText, selectElementText } from './clipboard.ts';
import { UNSUPPORTED_TEXT } from './types.ts';
import type { SidebarContextData, SidebarPendingView, SidebarState } from './types.ts';

export type WaitTier = 'calm' | 'warn' | 'urgent';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 等待时长分档：< 30 分钟灰、30 分钟–2 小时黄、> 2 小时红 */
export function waitTier(seconds: number): WaitTier {
  if (seconds >= 2 * HOUR) return 'urgent';
  if (seconds >= 30 * MINUTE) return 'warn';
  return 'calm';
}

export function formatWait(seconds: number): string {
  if (seconds < MINUTE) return '刚刚';
  const totalMinutes = Math.floor(seconds / MINUTE);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${String(minutes).padStart(2, '0')} 分`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

/** 同步时间：正着说「x 分钟前」 */
export function relativeLabel(seconds: number): string {
  if (seconds < MINUTE) return '刚刚';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} 分钟前`;
  if (seconds < 24 * HOUR) return `${Math.floor(seconds / HOUR)} 小时前`;
  return `${Math.floor(seconds / (24 * HOUR))} 天前`;
}

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface ViewHandlers {
  onRetry?: () => void;
  onRefresh?: () => void;
  /** 手动关闭：已处理 / 无需回复（「转交」按钮先隐藏，暂时没有分派流程） */
  onClose?: (id: string, reason: 'handled' | 'dismissed' | 'transferred') => void;
  /** 埋点：复制、查看等；失败由 api 层吞掉 */
  onEvent?: (event: 'sidebar.open' | 'pending.view' | 'pending.copy_excerpt' | 'draft.copy', itemId?: string) => void;
  /** 控制台地址；只有配置了才显示入口 */
  consoleUrl?: string;
}

/** 刷新：圆环箭头 + 文字，图标单独放太小，容易被当成装饰而不是按钮 */
function refreshButton(): string {
  return `<button type="button" class="refresh-btn" data-refresh aria-label="刷新">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
    <span>刷新</span>
  </button>`;
}

function skeleton(): string {
  return `
    <div class="skeleton skeleton-title"></div>
    <section class="card">
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
    </section>
    <section class="card">
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
    </section>
    <p class="hint">正在读取本会话…</p>`;
}

function noticeBanner(notice: { message: string; retryable: boolean }): string {
  return `<div class="notice" role="status">
    <span>${escapeHtml(notice.message)}</span>
    ${notice.retryable ? '<button type="button" class="link" data-retry>重试</button>' : ''}
  </div>`;
}

const RISK_LABEL = { low: '常规', medium: '需核对', high: '高风险' } as const;

/** #163：核验结果在条目上展示，替代原来机器人 1:1 的文字回执 */
const VERIFY_LABEL: Record<string, string> = {
  VERIFIED: '已送达',
  EDIT_SENT: '已送达（内容有改动）',
  MISROUTE_ALERT: '发到了别的群，请检查',
  UNVERIFIED: '存档里没找到，请确认',
};

/** 草稿块：正文两行、风险、规则来源、生成时间；高风险必须先展开再复制 */
function draftHtml(item: SidebarPendingView): string {
  const draft = item.draft;
  if (!draft) return '';
  const risk = RISK_LABEL[draft.riskLevel];
  const rules = draft.ruleNames.length
    ? `<p class="draft-rules">依据：${draft.ruleNames
        .slice(0, 2)
        .map((name) => escapeHtml(name))
        .join('、')}</p>`
    : '';
  const generated = relativeLabel(
    Math.max(0, Math.floor((Date.now() - draft.createdAt) / 1000)),
  );
  const high = draft.riskLevel === 'high';
  const verify =
    draft.verification && VERIFY_LABEL[draft.verification.outcome]
      ? `<p class="draft-verify">回读核验：${escapeHtml(VERIFY_LABEL[draft.verification.outcome]!)}</p>`
      : '';
  return `
    <div class="draft" data-draft-id="${escapeHtml(draft.id)}">
      <div class="draft-head">
        <span class="draft-label">草稿</span>
        <span class="pill risk-${draft.riskLevel}">${risk}</span>
        <span class="draft-time">${generated}生成</span>
      </div>
      <p class="draft-body">${escapeHtml(draft.body)}</p>
      ${rules}
      ${verify}
      <p class="draft-confirm" hidden>草稿涉及用药或就医建议，请先核对再发给客户。</p>
      <div class="ops">
        <button type="button" class="op" data-copy-draft="${
          high ? 'high' : 'normal'
        }">${high ? '展开核对' : '复制草稿'}</button>
      </div>
    </div>`;
}

function itemHtml(item: SidebarPendingView): string {
  const tier = waitTier(item.waitSeconds);
  const who = item.customerName ? escapeHtml(item.customerName) : '客户';
  const id = escapeHtml(item.id);
  return `
    <li class="item">
      <div class="item-head">
        <span class="dot dot-${tier}" aria-hidden="true"></span>
        <span class="who">${who}</span>
        <span class="wait wait-${tier}">等了 ${formatWait(item.waitSeconds)}</span>
      </div>
      <p class="excerpt">${escapeHtml(item.excerpt)}</p>
      ${draftHtml(item)}
      <div class="ops">
        <button type="button" class="op" data-copy="${escapeHtml(item.excerpt)}" data-item="${id}">复制原话</button>
        <button type="button" class="op" data-close="handled" data-item="${id}">已处理</button>
        <button type="button" class="op" data-close="dismissed" data-item="${id}">无需回复</button>
      </div>
      <p class="copy-hint" hidden>复制失败，已选中原文，请手动复制</p>
      ${item.aiReplied ? '<p class="note">机器人已回应</p>' : ''}
    </li>`;
}

function pendingCard(data: SidebarContextData): string {
  const { pending } = data;

  // 没有待回复就整块不出现：既然没有要处理的事，就不要占着一块区域说明「没有」
  if (pending.openCount === 0) return '';

  const syncedAt = data.conv.lastObservedAt;
  const sync = syncedAt === null
    ? ''
    : ` · 更新于 ${relativeLabel(Math.max(0, Math.floor((data.generatedAt - syncedAt) / 1000)))}`;

  const items = [...pending.open]
    .sort((a, b) => a.lastAt - b.lastAt)
    .map(itemHtml)
    .join('');

  const closed = pending.recentlyClosed.length
    ? `<details class="closed">
        <summary>已回复 ${pending.recentlyClosed.length} 条</summary>
        <ul>${pending.recentlyClosed
          .map(
            (item) =>
              `<li><span>${clockLabel(item.closedAt)} 已回复</span><span class="sub">${escapeHtml(
                item.closedBy ?? '顾问',
              )}</span></li>`,
          )
          .join('')}</ul>
      </details>`
    : '';

  return `
    <section class="card">
      <div class="card-head">
        <h2>待回复</h2>
        <span class="meta">${pending.openCount} 条${sync}</span>
      </div>
      <ul class="items">${items}</ul>
      ${closed}
    </section>`;
}

/** 存档同意状态的展示口径；未知值原样转义，不猜 */
const CONSENT_LABEL: Record<string, string> = {
  agreed: '已同意',
  unknown: '待确认',
  disagreed: '不同意',
};

function profileCard(data: SidebarContextData, consoleUrl?: string): string {
  const profile = data.profile;
  if (!profile || !profile.bound) {
    const unbound = data.conv.kind === 'dm' ? '本会话还没有绑定客户档案' : '本群还没有绑定客户档案';
    return `
      <section class="card">
        <div class="card-head"><h2>客户速览</h2></div>
        <p class="sub">${unbound}</p>
        ${consoleLink(consoleUrl)}
      </section>`;
  }

  const name = profile.name ? escapeHtml(profile.name) : '客户信息不可见';
  const confirmed = profile.confirmed
    ? '<span class="pill">本人已确认</span>'
    : '<span class="pill pill-muted">待确认</span>';
  // 速览是固定结构：每种信息都有一个位置，缺数据时显示占位，不整块消失
  const tags = profile.tags.length
    ? `<div class="tags">${profile.tags
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('')}</div>`
    : '<span class="field-empty">未打标签</span>';
  const consent = profile.consent
    ? escapeHtml(CONSENT_LABEL[profile.consent] ?? profile.consent)
    : '—';
  const groups = profile.groups.length
    ? profile.groups.map((group) => escapeHtml(group)).join('、')
    : '<span class="field-empty">未绑定服务群</span>';

  const facts: string[] = [];
  facts.push(`顾问：${profile.advisorName ? escapeHtml(profile.advisorName) : '—'}`);
  if (profile.servedDays !== null) facts.push(`服务 ${profile.servedDays} 天`);
  if (profile.silentDays !== null) {
    facts.push(profile.silentDays === 0 ? '今天活跃' : `沉默 ${profile.silentDays} 天`);
  }

  return `
    <section class="card">
      <div class="card-head">
        <h2>客户速览 · ${name}</h2>
        ${confirmed}
      </div>
      <p class="facts">${facts.join(' · ')}</p>
      <div class="profile-section">
        <h3 class="section-title">基础信息</h3>
        <dl class="fields">
          <div class="field"><dt>标签</dt><dd>${tags}</dd></div>
          <div class="field"><dt>存档</dt><dd>${consent}</dd></div>
          <div class="field"><dt>服务群</dt><dd>${groups}</dd></div>
        </dl>
      </div>
      ${chronicHtml(data, consoleUrl)}
      ${consoleLink(consoleUrl)}
    </section>`;
}

/** 慢病档案区块固定保留：没有档案时显示「尚未录入」，并指向控制台补录 */
function chronicHtml(data: SidebarContextData, consoleUrl?: string): string {
  const chronic = data.profile?.chronic;
  if (!chronic) {
    const action = consoleUrl
      ? ` · <a href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener noreferrer">去控制台补录</a>`
      : '';
    return `
      <div class="profile-section chronic">
        <h3 class="section-title">慢病档案</h3>
        <p class="field-empty">尚未录入${action}</p>
      </div>`;
  }

  const conditions = chronic.conditions.length
    ? `<p class="chronic-conditions">${chronic.conditions
        .map((condition) => escapeHtml(condition))
        .join('、')}</p>`
    : '';

  const metrics = chronic.measurements.length
    ? `<ul class="metrics">${chronic.measurements
        .map((measurement) => {
          const value =
            measurement.secondaryValue !== null
              ? `${measurement.value}/${measurement.secondaryValue}`
              : `${measurement.value}`;
          // 对话提取的数值还没被顾问核对，标出来，别让人当成已确认
          const unverified = measurement.source === 'agent'
            ? '<span class="metric-src">对话提取</span>'
            : '';
          const context = measurement.context
            ? `<span class="metric-context">${escapeHtml(measurement.context)}</span>`
            : '';
          return `<li class="metric">
            <span class="metric-label">${escapeHtml(measurement.label)}</span>
            <span class="metric-value">${escapeHtml(value)}<em>${escapeHtml(measurement.unit)}</em></span>
            ${context}${unverified}
            <span class="metric-date">${relativeSince(measurement.measuredAt)}</span>
          </li>`;
        })
        .join('')}</ul>`
    : '';

  const medications = chronic.medications.length
    ? `<p class="chronic-meds"><span class="chronic-label">用药</span>${chronic.medications
        .map((medication) => {
          const detail = [medication.dose, medication.frequency].filter(Boolean).join(' ');
          return escapeHtml(detail ? `${medication.name} ${detail}` : medication.name);
        })
        .join('；')}</p>`
    : '';

  return `
    <div class="profile-section chronic">
      <div class="chronic-head">
        <h3 class="section-title">慢病档案</h3>
        <span class="chronic-updated">${relativeSince(chronic.updatedAt)}更新</span>
      </div>
      ${conditions}
      ${metrics}
      ${medications}
    </div>`;
}

/** 时间戳 → 「刚刚 / x 分钟前 / x 天前」，与刷新提示同一套口径 */
function relativeSince(at: number): string {
  return relativeLabel(Math.max(0, Math.floor((Date.now() - at) / 1000)));
}

function consoleLink(consoleUrl?: string): string {
  if (!consoleUrl) return '';
  return `<p class="console"><a href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener noreferrer">打开控制台详情</a></p>`;
}

function ready(data: SidebarContextData, handlers: ViewHandlers, notice?: { message: string; retryable: boolean }): string {
  const title = data.conv.name ? escapeHtml(data.conv.name) : '当前会话';
  return `
    <header class="top">
      <div class="title-row">
        <h1>${title}</h1>
        ${refreshButton()}
      </div>
    </header>
    ${notice ? noticeBanner(notice) : ''}
    ${pendingCard(data)}
    ${profileCard(data, handlers.consoleUrl)}
    <p class="hint">内容来自本会话最近消息，仅负责顾问可见</p>`;
}

function message(title: string, detail: string, action?: { label: string; retry: boolean }): string {
  return `
    <div class="state">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      ${
        action
          ? `<button type="button" class="${action.retry ? 'retry' : 'link'}" ${
              action.retry ? 'data-retry' : 'data-refresh'
            }>${escapeHtml(action.label)}</button>`
          : ''
      }
    </div>`;
}

function bind(root: HTMLElement, handlers: ViewHandlers): void {
  root.querySelectorAll<HTMLElement>('[data-retry]').forEach((element) => {
    element.addEventListener('click', () => handlers.onRetry?.());
  });
  root.querySelectorAll<HTMLElement>('[data-refresh]').forEach((element) => {
    element.addEventListener('click', () => handlers.onRefresh?.());
  });
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      const text = button.dataset.copy ?? '';
      const item = button.closest('li');
      void copyText(text).then((ok) => {
        if (ok) {
          handlers.onEvent?.('pending.copy_excerpt', button.dataset.item);
          flashCopied(button, '复制原话');
          return;
        }
        // 兜底：选中原文，提示手动复制
        selectElementText(item?.querySelector('.excerpt') ?? null);
        const hint = item?.querySelector('.copy-hint');
        if (hint instanceof HTMLElement) hint.hidden = false;
      });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-copy-draft]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = button.closest('.draft');
      const body = draft?.querySelector('.draft-body')?.textContent ?? '';
      // 高风险：第一次点击只展开核对，确认后再点一次才复制
      if (button.dataset.copyDraft === 'high' && button.dataset.armed !== '1') {
        button.dataset.armed = '1';
        button.textContent = '确认并复制';
        const confirm = draft?.querySelector('.draft-confirm');
        if (confirm instanceof HTMLElement) confirm.hidden = false;
        return;
      }
      void copyText(body).then((ok) => {
        if (!ok) return;
        handlers.onEvent?.('draft.copy');
        flashCopied(button, button.dataset.copyDraft === 'high' ? '确认并复制' : '复制草稿');
      });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.item;
      const reason = button.dataset.close as 'handled' | 'dismissed' | 'transferred';
      if (!id || !handlers.onClose) return;
      // 防止重复点击：同一张卡片的动作全部置灰，失败由上层刷新恢复
      const item = button.closest('li');
      item?.querySelectorAll<HTMLButtonElement>('.op').forEach((op) => {
        op.disabled = true;
      });
      handlers.onClose(id, reason);
    });
  });
}

function flashCopied(button: HTMLButtonElement, restore: string): void {
  button.textContent = '已复制';
  button.classList.add('copied');
  window.setTimeout(() => {
    button.textContent = restore;
    button.classList.remove('copied');
  }, 2_000);
}

/** 手动刷新：请求期间图标转圈并禁用，避免连点；渲染后节点会被替换，无需还原 */
export function markRefreshBusy(root: HTMLElement, busy: boolean): void {
  const button = root.querySelector<HTMLButtonElement>('[data-refresh].refresh-btn');
  if (!button) return;
  button.classList.toggle('is-busy', busy);
  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/** 手动刷新完成：按钮短暂显示「已刷新」，否则数据没变时看不出点过 */
export function flashRefreshed(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>('[data-refresh].refresh-btn');
  const label = button?.querySelector('span');
  if (!button || !label) return;
  button.classList.add('is-done');
  button.setAttribute('aria-label', '已刷新');
  label.textContent = '已刷新';
  window.setTimeout(() => {
    button.classList.remove('is-done');
    button.setAttribute('aria-label', '刷新');
    label.textContent = '刷新';
  }, 1_500);
}

export function render(
  root: HTMLElement,
  state: SidebarState,
  handlers: ViewHandlers = {},
): void {
  let html: string;
  switch (state.kind) {
    case 'loading':
      html = skeleton();
      break;
    case 'ready':
      html = ready(state.data, handlers, state.notice);
      break;
    case 'unsupported': {
      const text = UNSUPPORTED_TEXT[state.reason];
      html = message(text.title, text.detail, { label: '重新加载', retry: true });
      break;
    }
    case 'auth-expired':
      html = message('登录已失效', '请从企微聊天窗口重新打开侧边栏。');
      break;
    case 'error':
      html = message(
        '侧边栏暂时打不开',
        state.message,
        state.retryable ? { label: '重试', retry: true } : undefined,
      );
      break;
  }
  root.innerHTML = html;
  bind(root, handlers);
}
