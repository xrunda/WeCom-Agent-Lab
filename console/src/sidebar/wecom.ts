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
  hint?: string;
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
  const value = result as WxConfigResult | undefined;
  const errMsg = typeof value?.errMsg === 'string' && value.errMsg !== '' ? value.errMsg : '未知原因';
  const hint = typeof value?.hint === 'string' && value.hint !== '' ? `（${value.hint}）` : '';
  return `${errMsg}${hint}`;
}

/**
 * 自建应用必须走 config + agentConfig 两条。
 *
 * 参数名是企微的固定写法：agentConfig 的 `corpid` / `agentid` 全小写，
 * `nonceStr` / `jsApiList` 驼峰；写成 corpId 时 SDK 读不到，会当成没传。
 * 个别客户端注入的对象认驼峰，两套都给。
 *
 * wx.config 少不得：jweixin 只在 `beta: true` 时才把 wx.invoke 挂到 wx 上，
 * 而取当前会话（getCurExternalChat / getCurExternalContact）全靠 wx.invoke。
 * config 失败不阻塞 agentConfig，最终以 agentConfig 结果为准。
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

    // config 用企业 ticket 的签名，agentConfig 用应用 ticket 的签名
    const configSignature = config.config ?? {
      timestamp: config.timestamp,
      nonceStr: config.nonceStr,
      signature: config.signature,
    };
    try {
      wx.config?.({
        beta: true,
        debug: false,
        appId: config.corpId,
        ...configSignature,
        jsApiList: config.jsApiList,
        success: () => {},
        fail: () => {},
      });
    } catch {
      // config 异常不阻塞 agentConfig
    }

    try {
      wx.agentConfig({
        // 官方写法：小写 corpid / agentid
        corpid: config.corpId,
        agentid: config.agentId,
        // 兼容按驼峰读参数的客户端
        corpId: config.corpId,
        agentId: config.agentId,
        timestamp: config.timestamp,
        nonceStr: config.nonceStr,
        signature: config.signature,
        jsApiList: config.jsApiList,
        success: () => finish(),
        fail: (result: WxConfigResult) =>
          finish(new WxConfigError(`JS-SDK 鉴权失败：${describeWxFailure(result)}`)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '调用异常';
      finish(new WxConfigError(`JS-SDK 不可用：${detail}`));
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
