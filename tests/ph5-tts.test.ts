/**
 * 患者端「听一听」：火山 TTS 客户端 / 缓存 / 内容朗读路由。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { H5Error } from '../src/p1/patient-h5.ts';
import { ContentService, MemoryContentBackend } from '../src/p1/patient-h5-content.ts';
import {
  decodeTtsAudio,
  inferResourceId,
  TtsAudioCache,
  TtsError,
  VOLC_TTS_DEFAULT_VOICE,
  VolcTtsClient,
  volcTtsFromEnv,
} from '../src/p1/patient-h5-tts.ts';
import { idFactory } from '../src/p1/ids.ts';
import { createContentRoutes, parseByteRange, ttsTextOf } from '../plugins/zhiban-patient-h5/routes/content.ts';

const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const b64 = AUDIO.toString('base64');

function v3Response(...chunks: string[]): string {
  return chunks
    .map((data) => JSON.stringify({ code: 0, message: 'ok', data }))
    .join('\n');
}

test('火山 TTS：缺凭据时 available=false，不发出请求', async () => {
  let called = false;
  const client = volcTtsFromEnv({}, {
    fetchImpl: (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch,
  });
  assert.equal(client.available, false);
  await assert.rejects(
    () => client.synthesize('早餐怎么吃'),
    (error: unknown) => error instanceof TtsError && error.code === 'TTS_NOT_CONFIGURED',
  );
  assert.equal(called, false);
});

test('火山 TTS：默认音色与资源 ID，v3 多块响应拼成完整音频', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const client = volcTtsFromEnv(
    { VOLC_TTS_API_KEY: 'test-key' },
    {
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(v3Response(b64, b64));
      }) as typeof fetch,
    },
  );
  assert.equal(client.available, true);
  assert.equal(client.voiceType, VOLC_TTS_DEFAULT_VOICE);
  assert.equal(client.resourceId, 'seed-tts-2.0');
  assert.equal(inferResourceId(VOLC_TTS_DEFAULT_VOICE), 'seed-tts-2.0');

  const audio = await client.synthesize('早餐，怎样吃得更丰富？');
  assert.deepEqual(audio, Buffer.concat([AUDIO, AUDIO]));

  assert.ok(captured);
  assert.equal(captured!.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  const headers = captured!.init.headers as Record<string, string>;
  assert.equal(headers['X-Api-Key'], 'test-key');
  assert.equal(headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  const body = JSON.parse(String(captured!.init.body)) as {
    req_params: { text: string; speaker: string; audio_params: { format: string } };
  };
  assert.equal(body.req_params.text, '早餐，怎样吃得更丰富？');
  assert.equal(body.req_params.speaker, VOLC_TTS_DEFAULT_VOICE);
  assert.equal(body.req_params.audio_params.format, 'mp3');
});

test('火山 TTS：appId + accessToken 走旧版鉴权头', async () => {
  let headers: Record<string, string> = {};
  const client = volcTtsFromEnv(
    { VOLC_TTS_APPID: 'app-1', VOLC_TTS_ACCESS_TOKEN: 'token-1' },
    {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return new Response(v3Response(b64));
      }) as typeof fetch,
    },
  );
  assert.equal(client.available, true);
  await client.synthesize('测试');
  assert.equal(headers['X-Api-App-Id'], 'app-1');
  assert.equal(headers['X-Api-Access-Key'], 'token-1');
  assert.equal(headers['X-Api-Key'], undefined);
});

test('火山 TTS：HTTP 错误 / 业务错误 / 空音频都归类为安全错误码', async () => {
  const httpError = new VolcTtsClient({
    apiKey: 'k',
    fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => httpError.synthesize('测试'),
    (error: unknown) => error instanceof TtsError && error.code === 'TTS_REQUEST_FAILED',
  );

  assert.throws(
    () => decodeTtsAudio(v3Response('')),
    (error: unknown) => error instanceof TtsError && error.code === 'TTS_EMPTY_AUDIO',
  );

  assert.throws(
    () => decodeTtsAudio(JSON.stringify({ code: 45000001, message: 'quota' })),
    (error: unknown) => error instanceof TtsError && error.code === 'TTS_REQUEST_FAILED',
  );
  assert.throws(() => decodeTtsAudio('not-json'), TtsError);
});

test('火山 TTS 缓存：同一音色 + 文本只合成一次，落盘可复用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiban-tts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = new TtsAudioCache(dir);
  let produced = 0;
  const produce = async (): Promise<Buffer> => {
    produced += 1;
    return AUDIO;
  };

  const first = await cache.getOrCreate(VOLC_TTS_DEFAULT_VOICE, '早餐怎么吃', produce);
  const second = await cache.getOrCreate(VOLC_TTS_DEFAULT_VOICE, '早餐怎么吃', produce);
  assert.deepEqual(first, AUDIO);
  assert.deepEqual(second, AUDIO);
  assert.equal(produced, 1);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^[a-f0-9]{64}\.mp3$/);

  // 并发请求共用同一次合成
  const other = new TtsAudioCache(dir);
  const results = await Promise.all([
    other.getOrCreate('voice-b', '并发', produce),
    other.getOrCreate('voice-b', '并发', produce),
  ]);
  assert.equal(results.length, 2);
  assert.equal(produced, 2);
});

test('Range 解析：首段 / 后缀 / 越界', () => {
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseByteRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseByteRange('bytes=5-100', 10), { start: 5, end: 9 });
  assert.equal(parseByteRange('bytes=10-', 10), 'invalid');
  assert.equal(parseByteRange('bytes=9-5', 10), 'invalid');
  assert.equal(parseByteRange('bytes=abc', 10), 'invalid');
  assert.equal(parseByteRange('bytes=-0', 10), 'invalid');
});

// ---------- 内容朗读路由 ----------

async function publishedContent(): Promise<{ content: ContentService; id: string }> {
  const content = new ContentService({
    tenantId: 'tn_tts',
    backend: new MemoryContentBackend(),
    ids: idFactory(() => 1_700_000_000_000),
  });
  const article = await content.create({
    category: 'classics_life',
    title: '早餐，怎样吃得更丰富？',
    summary: '几种家常搭配思路，让早餐更均衡、也更合口味。',
    sections: [
      {
        kind: 'classic_quote',
        text: '五谷为养，五果为助，五畜为益，五菜为充',
        citation: '《黄帝内经·素问·脏气法时论》',
        verified: true,
      },
    ],
    authorType: 'editor',
    authorName: '编辑部',
    actorId: 'acc_1',
  });
  await content.submitReview({ id: article.id, actorId: 'acc_1' });
  await content.publish({
    id: article.id,
    reviewerAccountId: 'acc_2',
    reviewerName: '陈营养师（虚构）',
  });
  return { content, id: article.id };
}

interface FakeRes {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer | string | undefined;
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): void;
  end(chunk?: string): void;
}

function fakeRes(): FakeRes {
  return {
    status: 0,
    headers: {},
    body: undefined,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      this.body = chunk as unknown as Buffer | string | undefined;
    },
  };
}

function ctxOf(path: string, method = 'GET') {
  return {
    method,
    path,
    query: new URLSearchParams(),
    requestId: 'req_tts',
    requireSession: async () => ({}) as never,
    ok: () => undefined,
    fail: () => undefined,
    readJson: async () => ({}),
    readRawBody: async () => Buffer.alloc(0),
    checkOrigin: () => undefined,
  } as never;
}

test('朗读路由：未配置 TTS 返回 503；Range 请求返回 206 与对应字节', async () => {
  const { content, id } = await publishedContent();
  const routes = createContentRoutes({
    content,
    tts: { available: true, audioFor: async () => Buffer.from(AUDIO) },
  });
  const audio = routes[1]!;

  const res = fakeRes();
  const handled = await audio({ headers: {} } as never, res as never, ctxOf(`/articles/${id}/audio`));
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.deepEqual(Buffer.from(res.body as Buffer), AUDIO);

  const ranged = fakeRes();
  await audio(
    { headers: { range: 'bytes=2-3' } } as never,
    ranged as never,
    ctxOf(`/articles/${id}/audio`),
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['Content-Range'], `bytes 2-3/${AUDIO.length}`);
  assert.deepEqual(Buffer.from(ranged.body as Buffer), AUDIO.subarray(2, 4));

  const invalid = fakeRes();
  await audio(
    { headers: { range: 'bytes=999-' } } as never,
    invalid as never,
    ctxOf(`/articles/${id}/audio`),
  );
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['Content-Range'], `bytes */${AUDIO.length}`);
});

test('朗读路由：未配置时 503，未发布内容 404，文本取标题 + 摘要', async () => {
  const { content, id } = await publishedContent();
  const disabled = createContentRoutes({ content })[1]!;
  await assert.rejects(
    () => disabled({ headers: {} } as never, fakeRes() as never, ctxOf(`/articles/${id}/audio`)),
    (error: unknown) => error instanceof H5Error && error.code === 'TTS_UNAVAILABLE',
  );

  let spoken = '';
  const enabled = createContentRoutes({
    content,
    tts: {
      available: true,
      audioFor: async (text) => {
        spoken = text;
        return Buffer.from(AUDIO);
      },
    },
  });
  const audio = enabled[1]!;
  await assert.rejects(
    () => audio({ headers: {} } as never, fakeRes() as never, ctxOf('/articles/art_missing/audio')),
    (error: unknown) => error instanceof H5Error && error.code === 'NOT_FOUND',
  );

  await audio({ headers: {} } as never, fakeRes() as never, ctxOf(`/articles/${id}/audio`));
  assert.match(spoken, /早餐，怎样吃得更丰富？/);
  assert.match(spoken, /几种家常搭配思路/);
  assert.equal(ttsTextOf({ title: 'A', summary: 'B' }), 'A。B');
  assert.equal(ttsTextOf({ title: '早餐，怎样吃得更丰富？', summary: 'B' }), '早餐，怎样吃得更丰富？B');
});
