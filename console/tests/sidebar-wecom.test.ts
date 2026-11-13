import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WxConfigError, configureAgent, resolveConversation } from '../src/sidebar/wecom.ts';
import type { WxLike } from '../src/sidebar/wecom.ts';

const CONFIG = {
  corpId: 'ww_test',
  agentId: '1000001',
  timestamp: '1700000000',
  nonceStr: 'nonce',
  signature: 'sig',
  jsApiList: ['getCurExternalChat'],
};

describe('JS-SDK 封装（#145）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('agentConfig 成功即 resolve', async () => {
    const wx: WxLike = {
      agentConfig: (options) => (options.success as () => void)(),
      invoke: () => {},
    };
    await expect(configureAgent(wx, CONFIG)).resolves.toBeUndefined();
  });

  it('agentConfig 失败时 reject，上层能显示可读错误', async () => {
    const wx: WxLike = {
      agentConfig: (options) => (options.fail as () => void)(),
      invoke: () => {},
    };
    await expect(configureAgent(wx, CONFIG)).rejects.toThrow(WxConfigError);
  });

  it('回调一直不来时超时失败，不会永远停在骨架', async () => {
    const wx: WxLike = {
      agentConfig: () => {
        // 企微在签名不匹配时可能不回调
      },
      invoke: () => {},
    };
    const pending = configureAgent(wx, CONFIG);
    const assertion = expect(pending).rejects.toThrow('JS-SDK 鉴权超时');
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  });

  it('先按外部群取 chatId', async () => {
    const wx: WxLike = {
      agentConfig: () => {},
      invoke: (_name, _args, callback) => callback({ err_msg: 'x:ok', chatId: 'wr_room' }),
    };
    await expect(resolveConversation(wx)).resolves.toEqual({ kind: 'group', chatId: 'wr_room' });
  });

  it('取不到群时退回单聊', async () => {
    const wx: WxLike = {
      agentConfig: () => {},
      invoke: (name, _args, callback) => {
        if (name === 'getCurExternalChat') callback({ err_msg: 'x:fail' });
        else callback({ err_msg: 'x:ok', userId: 'wm_external' });
      },
    };
    await expect(resolveConversation(wx)).resolves.toEqual({
      kind: 'dm',
      externalUserId: 'wm_external',
    });
  });

  it('两者都取不到时返回 unsupported', async () => {
    const wx: WxLike = {
      agentConfig: () => {},
      invoke: (_name, _args, callback) => callback({ err_msg: 'x:fail' }),
    };
    const pending = resolveConversation(wx);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ kind: 'unsupported' });
  });
});
