/**
 * 企微 JS-SDK 薄封装（#145）。
 *
 * 只做三件事：agentConfig、取当前会话、把失败翻译成可展示的状态。
 * 不引入 wx 的 npm 包——页面里由企微注入全局 `wx`，本地开发时不存在。
 */
import type { AgentConfig } from './types.ts';

export interface WxInvokeResult {
  err_msg?: string;
  chatId?: string;
  /** getCurExternalContact 返回的是外部联系人 userid */
  userId?: string;
}

export interface WxConfigResult {
  errMsg?: string;
}

export interface WxLike {
  agentConfig(options: Record<string, unknown>): void;
  config?(options: Record<string, unknown>): void;
  invoke(
    name: string,
    args: Record<string, unknown>,
    callback: (result: WxInvokeResult) => void,
  ): void;
}

export type ConversationRef =
  | { kind: 'group'; chatId: string }
  | { kind: 'dm'; externalUserId: string }
  | { kind: 'unsupported' };

const INVOKE_TIMEOUT_MS = 3_000;
/** 签名不对或可信域名没生效时 agentConfig 可能永不回调，超时按失败处理 */
const AGENT_CONFIG_TIMEOUT_MS = 6_000;

export class WxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxConfigError';
  }
}

/** 企微 errMsg 只有「接口名:fail 原因」，不含凭据，可以给用户看 */
function describeWxFailure(result: unknown): string {
  const errMsg = (result as WxConfigResult | undefined)?.errMsg;
  return typeof errMsg === 'string' && errMsg !== '' ? errMsg : '未知原因';
}

/**
 * 自建应用必须走 agentConfig。
 *
 * 企微桌面端会注入 wx 但与页面未建立联系，官方流程是先 config 再 agentConfig；
 * config 失败不阻塞 agentConfig，两者任一成功都算可用。
 */
export function configureAgent(wx: WxLike, config: AgentConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new WxConfigError('JS-SDK 鉴权超时')),
      AGENT_CONFIG_TIMEOUT_MS,
    );
    const signature = {
      timestamp: config.timestamp,
      nonceStr: config.nonceStr,
      signature: config.signature,
      jsApiList: config.jsApiList,
    };
    try {
      wx.config?.({
        beta: true,
        debug: false,
        appId: config.corpId,
        ...signature,
        success: () => {},
        fail: () => {},
      });
      wx.agentConfig({
        corpId: config.corpId,
        agentId: config.agentId,
        ...signature,
        success: () => finish(),
        fail: (result: WxConfigResult) =>
          finish(new WxConfigError(`JS-SDK 鉴权失败：${describeWxFailure(result)}`)),
      });
    } catch {
      finish(new WxConfigError('JS-SDK 不可用'));
    }
  });
}

function isOk(result: WxInvokeResult | undefined): boolean {
  if (!result) return false;
  if (result.err_msg === undefined) return true;
  return result.err_msg.endsWith(':ok');
}

/** 企微在非企微浏览器里不会回调，超时按「取不到」处理 */
function invokeOnce(wx: WxLike, name: string): Promise<WxInvokeResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: WxInvokeResult | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), INVOKE_TIMEOUT_MS);
    try {
      wx.invoke(name, {}, (result) => finish(result));
    } catch {
      finish(undefined);
    }
  });
}

/**
 * 先按外部群取 chatId，再按单聊取 externalUserId。
 * 两者都取不到（内部群、普通会话、非企微浏览器）返回 unsupported。
 */
export async function resolveConversation(wx: WxLike): Promise<ConversationRef> {
  const chat = await invokeOnce(wx, 'getCurExternalChat');
  if (isOk(chat) && chat?.chatId) return { kind: 'group', chatId: chat.chatId };

  const contact = await invokeOnce(wx, 'getCurExternalContact');
  if (isOk(contact) && contact?.userId) {
    return { kind: 'dm', externalUserId: contact.userId };
  }
  return { kind: 'unsupported' };
}

export function contextQuery(ref: ConversationRef): string {
  if (ref.kind === 'group') return `chatId=${encodeURIComponent(ref.chatId)}`;
  if (ref.kind === 'dm') return `externalUserId=${encodeURIComponent(ref.externalUserId)}`;
  return '';
}
