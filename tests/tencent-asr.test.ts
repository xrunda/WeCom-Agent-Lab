import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AsrError, TencentAsrClient, tencentAsrFromEnv } from '../src/c2/tencent-asr.ts';

const SECRET_ID = 'AKIDTEST';
const SECRET_KEY = 'test-secret';
const AUDIO = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33]);

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(payload: unknown, status = 200): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch) {
  return new TencentAsrClient({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    region: 'ap-shanghai',
    fetchImpl,
  });
}

test('凭据缺失时 available=false，调用直接报 ASR_NOT_CONFIGURED', async () => {
  const asr = tencentAsrFromEnv({});
  assert.equal(asr.available, false);
  await assert.rejects(
    () => asr.transcribe(AUDIO),
    (error: unknown) => error instanceof AsrError && error.code === 'ASR_NOT_CONFIGURED',
  );
});

test('转写请求带正确的签名头与请求体，返回去空白后的文本', async () => {
  const { impl, calls } = fakeFetch({ Response: { Result: '  晚上想吃点清淡的  ' } });
  const asr = client(impl);

  const text = await asr.transcribe(AUDIO, 'silk');

  assert.equal(text, '晚上想吃点清淡的');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://asr.tencentcloudapi.com');

  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDTEST\//);
  assert.match(headers.Authorization, /SignedHeaders=content-type;host/);
  assert.match(headers.Authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(headers['X-TC-Action'], 'SentenceRecognition');
  assert.equal(headers['X-TC-Version'], '2019-06-14');
  assert.equal(headers['X-TC-Region'], 'ap-shanghai');
  assert.match(headers['X-TC-Timestamp'], /^\d+$/);
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');

  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.EngSerViceType, '16k_zh');
  assert.equal(body.SourceType, 1);
  assert.equal(body.VoiceFormat, 'silk');
  assert.equal(body.Data, AUDIO.toString('base64'));
  assert.equal(body.DataLen, AUDIO.length);
});

test('腾讯云返回错误时映射为 AsrError 并保留错误码', async () => {
  const { impl } = fakeFetch({
    Response: {
      Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' },
      RequestId: 'req-1',
    },
  });

  await assert.rejects(
    () => client(impl).transcribe(AUDIO),
    (error: unknown) =>
      error instanceof AsrError &&
      error.code === 'ASR_AuthFailure.SignatureFailure' &&
      /签名错误/.test(error.message),
  );
});

test('HTTP 非 200 与空音频有明确错误码', async () => {
  const { impl } = fakeFetch({}, 500);
  await assert.rejects(
    () => client(impl).transcribe(AUDIO),
    (error: unknown) => error instanceof AsrError && error.code === 'ASR_HTTP',
  );

  const { impl: ok } = fakeFetch({ Response: { Result: '' } });
  await assert.rejects(
    () => client(ok).transcribe(Buffer.alloc(0)),
    (error: unknown) => error instanceof AsrError && error.code === 'ASR_EMPTY_AUDIO',
  );
});

test('按文件头自动识别语音格式（企微实测为 AMR）', async () => {
  const { impl, calls } = fakeFetch({ Response: { Result: '你好' } });
  const asr = client(impl);

  const amr = Buffer.concat([Buffer.from('#!AMR\n', 'latin1'), Buffer.from([0x0c, 0xca])]);
  await asr.transcribe(amr);
  assert.equal(JSON.parse(String(calls[0].init.body)).VoiceFormat, 'amr');

  await asr.transcribe(AUDIO);
  assert.equal(JSON.parse(String(calls[1].init.body)).VoiceFormat, 'silk');

  // 显式指定的格式优先于自动识别
  await asr.transcribe(AUDIO, 'wav');
  assert.equal(JSON.parse(String(calls[2].init.body)).VoiceFormat, 'wav');
});

test('无法识别的音频格式直接报错，不请求云端', async () => {
  const { impl, calls } = fakeFetch({ Response: { Result: '' } });
  await assert.rejects(
    () => client(impl).transcribe(Buffer.from('not-audio')),
    (error: unknown) => error instanceof AsrError && error.code === 'ASR_UNKNOWN_FORMAT',
  );
  assert.equal(calls.length, 0);
});

test('Base64 后超过 3 MB 时不再发请求', async () => {
  const { impl, calls } = fakeFetch({ Response: { Result: '' } });
  const tooLarge = Buffer.alloc(3 * 1024 * 1024);

  await assert.rejects(
    () => client(impl).transcribe(tooLarge),
    (error: unknown) => error instanceof AsrError && error.code === 'ASR_TOO_LARGE',
  );
  assert.equal(calls.length, 0);
});
