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
  /** 控制台地址；只有配置了才显示入口 */
  consoleUrl?: string;
}

function refreshIcon(): string {
  return `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M10 3a7 7 0 1 1-6.65 9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    <path d="M3 4.5V9h4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
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

function itemHtml(item: SidebarPendingView): string {
  const tier = waitTier(item.waitSeconds);
  const who = item.customerName ? escapeHtml(item.customerName) : '客户';
  return `
    <li class="item">
      <div class="item-head">
        <span class="dot dot-${tier}" aria-hidden="true"></span>
        <span class="who">${who}</span>
        <span class="wait wait-${tier}">等了 ${formatWait(item.waitSeconds)}</span>
      </div>
      <p class="excerpt">${escapeHtml(item.excerpt)}</p>
      <div class="ops">
        <button type="button" class="op" data-copy="${escapeHtml(item.excerpt)}">复制原话</button>
        <button type="button" class="op" disabled title="本会话暂无草稿">生成回复</button>
      </div>
      <p class="copy-hint" hidden>复制失败，已选中原文，请手动复制</p>
      ${item.aiReplied ? '<p class="note">机器人已回应</p>' : ''}
    </li>`;
}

function pendingCard(data: SidebarContextData): string {
  const { pending } = data;
  const syncedAt = data.conv.lastObservedAt;
  const sync = syncedAt === null
    ? ''
    : ` · 更新于 ${relativeLabel(Math.max(0, Math.floor((data.generatedAt - syncedAt) / 1000)))}`;

  if (pending.openCount === 0) {
    return `
      <section class="card">
        <div class="card-head">
          <h2>待回复</h2>
          <span class="meta">本会话没有待回复${sync}</span>
        </div>
        <p class="sub">有客户提问时会在这里提醒</p>
      </section>`;
  }

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

function profileCard(data: SidebarContextData, consoleUrl?: string): string {
  const profile = data.profile;
  if (!profile || !profile.bound) {
    return `
      <section class="card">
        <div class="card-head"><h2>客户速览</h2></div>
        <p class="sub">本群还没有绑定客户档案</p>
        ${consoleLink(consoleUrl)}
      </section>`;
  }

  const name = profile.name ? escapeHtml(profile.name) : '客户信息不可见';
  const confirmed = profile.confirmed
    ? '<span class="pill">本人已确认</span>'
    : '<span class="pill pill-muted">待确认</span>';
  const tags = profile.tags.length
    ? `<div class="tags">${profile.tags
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('')}</div>`
    : '';
  const facts: string[] = [];
  if (profile.silentDays !== null) {
    facts.push(profile.silentDays === 0 ? '今天活跃' : `沉默 ${profile.silentDays} 天`);
  }
  if (profile.advisorName) facts.push(`顾问：${escapeHtml(profile.advisorName)}`);

  return `
    <section class="card">
      <div class="card-head">
        <h2>客户速览 · ${name}</h2>
        ${confirmed}
      </div>
      ${tags}
      <p class="sub">档案详情暂未接入</p>
      ${facts.length ? `<p class="facts">${facts.join(' · ')}</p>` : ''}
      ${consoleLink(consoleUrl)}
    </section>`;
}

function consoleLink(consoleUrl?: string): string {
  if (!consoleUrl) return '';
  return `<p class="console"><a href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener noreferrer">打开控制台详情</a></p>`;
}

function ready(data: SidebarContextData, handlers: ViewHandlers, notice?: { message: string; retryable: boolean }): string {
  const title = data.conv.name ? escapeHtml(data.conv.name) : '当前会话';
  return `
    <header class="top">
      <div class="brand-row">
        <span class="brand">知伴健康</span>
        <button type="button" class="icon-btn" data-refresh aria-label="刷新">${refreshIcon()}</button>
      </div>
      <h1>${title}</h1>
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
          button.textContent = '已复制';
          button.classList.add('copied');
          window.setTimeout(() => {
            button.textContent = '复制原话';
            button.classList.remove('copied');
          }, 2_000);
          return;
        }
        // 兜底：选中原文，提示手动复制
        selectElementText(item?.querySelector('.excerpt') ?? null);
        const hint = item?.querySelector('.copy-hint');
        if (hint instanceof HTMLElement) hint.hidden = false;
      });
    });
  });
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
