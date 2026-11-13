/**
 * 侧边栏前端的数据形状（#145）。
 *
 * 与 `/zhiban/sidebar/context` 的响应一一对应；前端不 import 服务端模块，
 * 避免把判定逻辑打进 H5 包。
 */

export interface AgentConfig {
  corpId: string;
  agentId: string;
  timestamp: string;
  nonceStr: string;
  signature: string;
  jsApiList: string[];
}

export interface SidebarPendingView {
  id: string;
  customerId: string;
  customerName: string | null;
  firstAt: number;
  lastAt: number;
  messageCount: number;
  excerpt: string;
  waitSeconds: number;
  reason: string;
  aiReplied: boolean;
  hasDraft: boolean;
}

export interface SidebarProfileView {
  bound: boolean;
  name: string | null;
  confirmed: boolean;
  tags: string[];
  chronic: null;
  carePlan: null;
  silentDays: number | null;
  advisorName: string | null;
}

export interface SidebarContextData {
  conv: {
    kind: 'group' | 'dm';
    key: string | null;
    name: string | null;
    served: boolean;
    reason?: 'GROUP_NOT_FOUND' | 'DM_NOT_SUPPORTED' | 'NOT_BOUND';
    lastObservedAt: number | null;
  };
  pending: {
    open: SidebarPendingView[];
    recentlyClosed: Array<{ id: string; closedAt: number; closedBy: string | null }>;
    openCount: number;
    oldestWaitSeconds: number | null;
  };
  profile: SidebarProfileView | null;
  generatedAt: number;
}

export type SidebarState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      data: SidebarContextData;
      /** 刷新失败时保留上次内容，在卡片上方提示 */
      notice?: { message: string; retryable: boolean };
    }
  | { kind: 'unsupported'; reason: UnsupportedReason }
  | { kind: 'auth-expired' }
  | { kind: 'error'; message: string; retryable: boolean };

export type UnsupportedReason =
  | 'NO_CONVERSATION'
  | 'GROUP_NOT_FOUND'
  | 'DM_NOT_SUPPORTED'
  | 'NOT_BOUND';

export const UNSUPPORTED_TEXT: Record<UnsupportedReason, { title: string; detail: string }> = {
  NO_CONVERSATION: {
    title: '本会话未接入服务',
    detail: '侧边栏只在客户群或客户单聊里打开；内部群和普通会话不显示服务信息。',
  },
  GROUP_NOT_FOUND: {
    title: '本群还未接入服务',
    detail: '这个客户群还没有登记到知伴服务里，请联系管理员开通后再使用侧边栏。',
  },
  DM_NOT_SUPPORTED: {
    title: '客户单聊暂未接入',
    detail: '单聊的待回复提醒还在接入中；请先在客户群里使用侧边栏。',
  },
  NOT_BOUND: {
    title: '本群未绑定客户',
    detail: '群已接入服务，但还没有绑定客户档案，暂时看不到客户速览。',
  },
};
