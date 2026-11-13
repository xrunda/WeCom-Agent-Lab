/**
 * 侧边栏首屏渲染（#145 骨架；卡片细节在 #148 补全）。
 *
 * 只依赖 DOM，不引入组件库；所有动态文本先转义。
 */
import { UNSUPPORTED_TEXT } from './types.ts';
import type { SidebarContextData, SidebarState } from './types.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function skeleton(): string {
  return `
    <header class="top">
      <span class="brand">知伴健康</span>
      <div class="skeleton skeleton-title"></div>
    </header>
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

function pendingCard(data: SidebarContextData): string {
  const { pending } = data;
  if (pending.openCount === 0) {
    return `
      <section class="card">
        <h2>待回复</h2>
        <p class="ok">本群没有未回复的消息</p>
        <p class="sub">有客户提问时会在这里提醒</p>
      </section>`;
  }
  const wait = pending.oldestWaitSeconds === null ? '' : ` · 已等 ${formatWait(pending.oldestWaitSeconds)}`;
  return `
      <section class="card">
        <div class="card-head">
          <h2>待回复</h2>
          <span class="badge">${pending.openCount} 条${wait}</span>
        </div>
        <p class="sub">回复原话，告诉客户你已看到</p>
      </section>`;
}

function profileCard(data: SidebarContextData): string {
  const profile = data.profile;
  if (!profile || !profile.bound) {
    return `
      <section class="card">
        <h2>客户速览</h2>
        <p class="sub">本群还没有绑定客户档案</p>
      </section>`;
  }
  const name = profile.name ? escapeHtml(profile.name) : '客户信息不可见';
  const tags = profile.tags.length
    ? `<div class="tags">${profile.tags
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('')}</div>`
    : '';
  const silent =
    profile.silentDays === null
      ? ''
      : `<p class="sub">最近活跃：${profile.silentDays === 0 ? '今天' : `${profile.silentDays} 天前`}</p>`;
  const advisor = profile.advisorName ? `<p class="sub">负责顾问：${escapeHtml(profile.advisorName)}</p>` : '';
  return `
      <section class="card">
        <h2>客户速览</h2>
        <p class="name">${name}</p>
        ${tags}
        ${silent}
        ${advisor}
      </section>`;
}

function ready(data: SidebarContextData): string {
  const title = data.conv.name ? escapeHtml(data.conv.name) : '当前会话';
  return `
    <header class="top">
      <span class="brand">知伴健康</span>
      <h1>${title}</h1>
    </header>
    ${pendingCard(data)}
    ${profileCard(data)}
    <p class="hint">数据来自本会话的最近消息</p>`;
}

function message(title: string, detail: string, retry: boolean): string {
  return `
    <div class="state">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      ${retry ? '<button type="button" class="retry" data-retry>重新加载</button>' : ''}
    </div>`;
}

export function render(
  root: HTMLElement,
  state: SidebarState,
  onRetry?: () => void,
): void {
  let html: string;
  switch (state.kind) {
    case 'loading':
      html = skeleton();
      break;
    case 'ready':
      html = ready(state.data);
      break;
    case 'unsupported': {
      const text = UNSUPPORTED_TEXT[state.reason];
      html = message(text.title, text.detail, state.reason === 'GROUP_NOT_FOUND');
      break;
    }
    case 'error':
      html = message('侧边栏暂时打不开', state.message, state.retryable);
      break;
  }
  root.innerHTML = html;
  const retry = root.querySelector('[data-retry]');
  if (retry && onRetry) retry.addEventListener('click', onRetry);
}
