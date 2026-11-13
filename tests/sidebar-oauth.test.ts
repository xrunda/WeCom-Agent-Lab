/**
 * #145 企微 OAuth 与 JS-SDK 签名：换 userid、ticket 缓存、签名与错误脱敏。
 * 全部用假 fetch，不访问企微。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  WecomOAuthClient,
  WecomOAuthError,
  isSameOrigin,
} from '../plugins/zhiban-sidebar/wecom-oauth.ts';
import type { WecomFetch } from '../plugins/zhiban-sidebar/wecom-oauth.ts';

function fakeFetch(responses: unknown[]): { fn: WecomFetch; calls: string[] } {
  const calls: string[] = [];
  const fn: WecomFetch = async (url) => {
    calls.push(url);
    const body = responses.shift() ?? { errcode: 0 };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fn, calls };
}

const BASE = 'https://zhiban.example.com';

function client(fetchImpl: WecomFetch, now = () => 1_700_000_000_000) {
  return new WecomOAuthClient({
    corpId: 'corp_test',
    agentId: '1000212',
    agentSecret: 'secret_test',
    publicBaseUrl: BASE,
    fetch: fetchImpl,
    now,
  });
}

test('三项凭据与公网地址齐全才算启用', () => {
  const { fn } = fakeFetch([]);
  assert.equal(client(fn).configured, true);
  const partial = new WecomOAuthClient({ corpId: 'c', agentId: '1', fetch: fn });
  assert.equal(partial.configured, false);
});

test('授权地址带 appid、回调、静默授权与 state', () => {
  const { fn } = fakeFetch([]);
  const url = new URL(client(fn).authorizeUrl('123.sig'));
  assert.equal(url.origin, 'https://open.weixin.qq.com');
  assert.equal(url.searchParams.get('appid'), 'corp_test');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    `${BASE}/zhiban/sidebar/auth/callback`,
  );
  assert.equal(url.searchParams.get('scope'), 'snsapi_base');
  assert.equal(url.searchParams.get('state'), '123.sig');
  assert.equal(url.hash, '#wechat_redirect');
});

test('code 换 userid；非成员只有 openid', async () => {
  const { fn, calls } = fakeFetch([
    { errcode: 0, access_token: 'token_1', expires_in: 7200 },
    { errcode: 0, userid: 'zhang.guwen' },
    { errcode: 0, openid: 'openid_x' },
  ]);
  const oauth = client(fn);
  assert.deepEqual(await oauth.exchangeCode('CODE1'), { userid: 'zhang.guwen' });
  assert.deepEqual(await oauth.exchangeCode('CODE2'), { openid: 'openid_x' });
  // 第二次复用缓存 token，不再请求 gettoken
  assert.equal(calls.filter((url) => url.includes('/gettoken')).length, 1);
  assert.ok(calls[1]!.includes('code=CODE1'));
});

test('access_token 过期后重新获取', async () => {
  let now = 1_700_000_000_000;
  const { fn, calls } = fakeFetch([
    { errcode: 0, access_token: 'token_1', expires_in: 7200 },
    { errcode: 0, userid: 'a' },
    { errcode: 0, access_token: 'token_2', expires_in: 7200 },
    { errcode: 0, userid: 'b' },
  ]);
  const oauth = client(fn, () => now);
  await oauth.exchangeCode('C1');
  now += 3 * 60 * 60_000;
  await oauth.exchangeCode('C2');
  assert.equal(calls.filter((url) => url.includes('/gettoken')).length, 2);
  assert.ok(calls.at(-1)!.includes('access_token=token_2'));
});

test('agentConfig 签名可按企微规则复算，ticket 只取一次', async () => {
  const { fn, calls } = fakeFetch([
    { errcode: 0, access_token: 'token_1', expires_in: 7200 },
    { errcode: 0, ticket: 'TICKET1', expires_in: 7200 },
  ]);
  const oauth = client(fn);
  const url = `${BASE}/sidebar/?chatId=chat_1`;
  const first = await oauth.signAgentConfig(url);
  const second = await oauth.signAgentConfig(url);

  const expected = createHash('sha1')
    .update(
      `jsapi_ticket=TICKET1&noncestr=${first.nonceStr}&timestamp=${first.timestamp}&url=${url}`,
    )
    .digest('hex');
  assert.equal(first.signature, expected);
  assert.equal(first.corpId, 'corp_test');
  assert.equal(first.agentId, '1000212');
  assert.notEqual(first.nonceStr, second.nonceStr);
  assert.equal(calls.filter((item) => item.includes('/get_jsapi_ticket')).length, 1);
});

test('拒绝为其它来源的页面签名', async () => {
  const { fn } = fakeFetch([]);
  await assert.rejects(
    () => client(fn).signAgentConfig('https://evil.example.com/sidebar/'),
    (error: unknown) => error instanceof WecomOAuthError && error.code === 'URL_NOT_ALLOWED',
  );
  assert.equal(isSameOrigin(`${BASE}/sidebar/`, BASE), true);
  assert.equal(isSameOrigin('https://evil.example.com/', BASE), false);
  assert.equal(isSameOrigin('not-a-url', BASE), false);
});

test('企微报错只带 errcode，不带 Secret 与 URL', async () => {
  const { fn } = fakeFetch([{ errcode: 40013, errmsg: 'invalid corpid' }]);
  await assert.rejects(
    () => client(fn).exchangeCode('CODE'),
    (error: unknown) => {
      assert.ok(error instanceof WecomOAuthError);
      assert.equal(error.code, 'TOKEN_FAILED');
      assert.ok(error.message.includes('40013'));
      assert.ok(!error.message.includes('secret_test'));
      assert.ok(!error.message.includes('qyapi.weixin.qq.com'));
      assert.ok(!error.message.includes('CODE'));
      return true;
    },
  );
});

test('网络异常只报错误类型，不回显 URL', async () => {
  const failing: WecomFetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => client(failing).exchangeCode('CODE_SECRET'),
    (error: unknown) => {
      assert.ok(error instanceof WecomOAuthError);
      assert.equal(error.code, 'NETWORK_FAILED');
      assert.ok(!error.message.includes('CODE_SECRET'));
      assert.ok(!error.message.includes('qyapi'));
      return true;
    },
  );
});
