import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WeComArchiveAdapter, type ArchiveRecord } from '../src/c2/adapters/wecom-archive.ts';
import { MediaDownloader, md5Of } from '../src/c2/media.ts';
import type { MediaChunk, MediaChunkSource } from '../src/c2/media.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

class FakeSource implements MediaChunkSource {
  calls = 0;
  private readonly chunk: MediaChunk | Error;

  constructor(chunk: MediaChunk | Error) {
    this.chunk = chunk;
  }

  async fetchChunk(): Promise<MediaChunk> {
    this.calls += 1;
    if (this.chunk instanceof Error) throw this.chunk;
    return this.chunk;
  }
}

function imageRecord(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    msgid: 'msg_img_1',
    action: 'recv',
    from: 'wmCUSTOMER',
    roomid: 'wrGROUP1',
    msgtime: 1_000,
    msgtype: 'image',
    image: {
      sdkfileid: 'file-1',
      md5: md5Of(PNG),
      filesize: PNG.length,
    },
    ...overrides,
  };
}

function dump(messages: ArchiveRecord[]): string {
  return JSON.stringify({ nextSeq: messages.length > 0 ? 10 : 10, count: messages.length, messages });
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zhiban-archive-media-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function adapterWith(
  root: string,
  source: FakeSource,
  messages: ArchiveRecord[],
  isServiceGroup: (roomId: string) => boolean,
  transcribeVoice?: (audio: Buffer) => Promise<string>,
): WeComArchiveAdapter {
  return new WeComArchiveAdapter({
    binaryPath: '/bin/archive_dump',
    privateKeyPath: './private_key.pem',
    configPath: './config.txt',
    isServiceGroup,
    transcribeVoice,
    media: {
      rootDir: root,
      downloader: new MediaDownloader(source, { rootDir: root, retryDelayMs: 0 }),
    },
    run: async () => dump(messages),
  });
}

const SILK = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33]);

function voiceRecord(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    msgid: 'msg_voice_1',
    action: 'recv',
    from: 'wmCUSTOMER',
    roomid: 'wrGROUP1',
    msgtime: 1_000,
    msgtype: 'voice',
    voice: {
      sdkfileid: 'voice-file-1',
      md5sum: md5Of(SILK),
      voice_size: SILK.length,
      play_length: 2,
    },
    ...overrides,
  };
}

test('服务群图片下载后返回 mediaPath / md5 / size', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: PNG, isFinish: true });
    const adapter = adapterWith(root, source, [imageRecord()], () => true);

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].msgtype, 'image');
    assert.equal(messages[0].mediaSize, PNG.length);
    assert.equal(messages[0].mediaMd5, md5Of(PNG));
    assert.ok(messages[0].mediaPath);
    assert.deepEqual(await readFile(messages[0].mediaPath!), PNG);
  });
});

test('非服务群图片不下载、不落盘，正文也不进缓存', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: PNG, isFinish: true });
    const adapter = adapterWith(
      root,
      source,
      [imageRecord({ msgid: 'msg_non_service', text: { content: '不应出现的正文' } })],
      () => false,
    );

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 0);
    assert.equal(source.calls, 0);
    assert.equal(adapter.listCached()[0]?.text, undefined);
  });
});

test('图片下载失败时标记 mediaFailed，消息仍返回', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource(new Error('NETWORK'));
    const adapter = adapterWith(root, source, [imageRecord()], () => true);

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].mediaFailed, true);
    assert.equal(messages[0].mediaPath, undefined);
  });
});

test('缺少 sdkfileid 时标记 mediaFailed，不调用下载', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: PNG, isFinish: true });
    const adapter = adapterWith(root, source, [imageRecord({ image: {} })], () => true);

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].mediaFailed, true);
    assert.equal(source.calls, 0);
  });
});

test('未启用 includeMedia 时不返回图片消息', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: PNG, isFinish: true });
    const adapter = adapterWith(root, source, [imageRecord()], () => true);

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
    });

    assert.equal(messages.length, 0);
  });
});

test('图片 md5 与存档不一致时标记 mediaFailed', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: PNG, isFinish: true });
    const adapter = adapterWith(
      root,
      source,
      [imageRecord({ image: { sdkfileid: 'file-1', md5: 'deadbeef', filesize: PNG.length } })],
      () => true,
    );

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages[0].mediaFailed, true);
    assert.equal(messages[0].mediaPath, undefined);
  });
});

test('服务群语音转写后填入 text，音频不落盘', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: SILK, isFinish: true });
    let received: Buffer | undefined;
    const adapter = adapterWith(root, source, [voiceRecord()], () => true, async (audio) => {
      received = audio;
      return '  晚上想吃点清淡的  ';
    });

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].msgtype, 'voice');
    assert.equal(messages[0].text, '晚上想吃点清淡的');
    assert.equal(messages[0].mediaPath, undefined);
    assert.deepEqual(received, SILK);
    // 语音不落盘
    assert.deepEqual(await readdir(root), []);
  });
});

test('语音转写失败的消息不进入服务流', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: SILK, isFinish: true });
    const adapter = adapterWith(root, source, [voiceRecord()], () => true, async () => {
      throw new Error('ASR_DOWN');
    });

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 0);
    const cached = adapter.listCached()[0] as { voiceFailed?: boolean };
    assert.equal(cached.voiceFailed, true);
  });
});

test('识别结果为空的消息不进入服务流', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: SILK, isFinish: true });
    const adapter = adapterWith(root, source, [voiceRecord()], () => true, async () => '   ');

    const messages = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(messages.length, 0);
  });
});

test('未配置 ASR 时语音消息保持不处理', async () => {
  await withRoot(async (root) => {
    const source = new FakeSource({ data: SILK, isFinish: true });
    const adapter = adapterWith(root, source, [voiceRecord()], () => true);

    const withMedia = await adapter.listInboundMessages({
      roomIds: ['wrGROUP1'],
      excludeSender: 'LiGuang',
      since: 0,
      until: 10_000,
      includeMedia: true,
    });

    assert.equal(withMedia.length, 0);
    assert.equal(source.calls, 0);
  });
});
