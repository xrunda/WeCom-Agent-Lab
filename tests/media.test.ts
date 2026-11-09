import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  ArchiveDumpMediaSource,
  MediaDownloader,
  MediaError,
  detectImageExt,
  downloadMedia,
  md5Of,
  sanitizeSegment,
} from '../src/c2/media.ts';
import type { MediaChunk, MediaChunkSource } from '../src/c2/media.ts';

class FakeSource implements MediaChunkSource {
  readonly calls: Array<[string, string]> = [];
  private readonly chunks: Array<MediaChunk | Error>;

  constructor(chunks: Array<MediaChunk | Error>) {
    this.chunks = chunks;
  }

  async fetchChunk(sdkfileid: string, indexbuf: string): Promise<MediaChunk> {
    this.calls.push([sdkfileid, indexbuf]);
    const chunk = this.chunks[Math.min(this.calls.length - 1, this.chunks.length - 1)];
    if (chunk instanceof Error) throw chunk;
    return chunk;
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

test('分片按 indexbuf 循环拼接，直到 isFinish', async () => {
  const source = new FakeSource([
    { data: Buffer.from('abc'), isFinish: false, nextIndexbuf: 'i1' },
    { data: Buffer.from('def'), isFinish: true },
  ]);

  const buffer = await downloadMedia(source, 'file-1', { retryDelayMs: 0 });

  assert.equal(buffer.toString(), 'abcdef');
  assert.deepEqual(source.calls, [
    ['file-1', ''],
    ['file-1', 'i1'],
  ]);
});

test('单个分片失败后重试，成功则继续', async () => {
  const source = new FakeSource([
    new Error('NETWORK'),
    { data: Buffer.from('ok'), isFinish: true },
  ]);

  const buffer = await downloadMedia(source, 'file-1', { retries: 2, retryDelayMs: 0 });

  assert.equal(buffer.toString(), 'ok');
  assert.equal(source.calls.length, 2);
});

test('重试耗尽后抛出 MEDIA_* 错误', async () => {
  const source = new FakeSource([new Error('NETWORK')]);

  await assert.rejects(
    downloadMedia(source, 'file-1', { retries: 1, retryDelayMs: 0 }),
    (error: unknown) => error instanceof Error && /NETWORK/.test(error.message),
  );
  assert.equal(source.calls.length, 2);
});

test('空分片且未结束视为没有进展', async () => {
  const source = new FakeSource([{ data: Buffer.alloc(0), isFinish: false, nextIndexbuf: 'i1' }]);

  await assert.rejects(
    downloadMedia(source, 'file-1', { retryDelayMs: 0 }),
    (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_NO_PROGRESS',
  );
});

test('indexbuf 不前进视为没有进展', async () => {
  const source = new FakeSource([
    { data: Buffer.from('a'), isFinish: false, nextIndexbuf: 'same' },
    { data: Buffer.from('b'), isFinish: false, nextIndexbuf: 'same' },
  ]);

  await assert.rejects(
    downloadMedia(source, 'file-1', { retryDelayMs: 0 }),
    (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_NO_PROGRESS',
  );
});

test('超过单张上限时抛 MEDIA_TOO_LARGE', async () => {
  const source = new FakeSource([
    { data: Buffer.alloc(8), isFinish: false, nextIndexbuf: 'i1' },
    { data: Buffer.alloc(8), isFinish: true },
  ]);

  await assert.rejects(
    downloadMedia(source, 'file-1', { maxBytes: 10, retryDelayMs: 0 }),
    (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_TOO_LARGE',
  );
});

test('缺少 sdkfileid 直接拒绝', async () => {
  const source = new FakeSource([]);

  await assert.rejects(
    downloadMedia(source, '  '),
    (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_MISSING_FILEID',
  );
});

test('落盘路径按 roomid/msgid 分层，并校验大小与 md5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiban-media-'));
  try {
    const source = new FakeSource([{ data: PNG, isFinish: true }]);
    const downloader = new MediaDownloader(source, { rootDir: root });
    const expectedMd5 = md5Of(PNG);

    const saved = await downloader.save({
      sdkfileid: 'file-1',
      roomId: 'wrGROUP_1',
      msgId: 'msg_1',
      expectedMd5,
      expectedSize: PNG.length,
    });

    assert.equal(saved.ext, 'png');
    assert.equal(saved.size, PNG.length);
    assert.equal(saved.md5, expectedMd5);
    assert.equal(relative(root, saved.path), join('wrGROUP_1', 'msg_1.png'));
    assert.deepEqual(await readFile(saved.path), PNG);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('大小与 md5 不一致时拒绝落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiban-media-'));
  try {
    const downloader = new MediaDownloader(new FakeSource([{ data: PNG, isFinish: true }]), {
      rootDir: root,
    });

    await assert.rejects(
      downloader.save({ sdkfileid: 'f', roomId: 'r', msgId: 'm', expectedSize: PNG.length + 1 }),
      (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_SIZE_MISMATCH',
    );
    await assert.rejects(
      downloader.save({ sdkfileid: 'f', roomId: 'r', msgId: 'm', expectedMd5: 'deadbeef' }),
      (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_MD5_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('群 id / 消息 id 中的路径字符被替换，避免目录穿越', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiban-media-'));
  try {
    const downloader = new MediaDownloader(new FakeSource([{ data: PNG, isFinish: true }]), {
      rootDir: root,
    });
    const saved = await downloader.save({ sdkfileid: 'f', roomId: '../x/y', msgId: './z' });

    assert.equal(relative(root, saved.path), join('___x_y', '__z.png'));
    assert.equal(sanitizeSegment(''), '_');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('按文件头识别扩展名；识别不了落 .bin', () => {
  assert.equal(detectImageExt(PNG), 'png');
  assert.equal(detectImageExt(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'jpg');
  assert.equal(detectImageExt(Buffer.from('GIF89a')), 'gif');
  assert.equal(detectImageExt(Buffer.from('RIFF0000WEBP')), 'webp');
  assert.equal(detectImageExt(Buffer.from('PK\u0003\u0004')), 'bin');
});

test('ArchiveDumpMediaSource 解析 base64 分片输出', async () => {
  const calls: string[][] = [];
  const payload = Buffer.from('hello');
  const source = new ArchiveDumpMediaSource({
    binaryPath: '/bin/archive_dump',
    configPath: './config.txt',
    run: async (args) => {
      calls.push(args);
      return JSON.stringify({
        data: payload.toString('base64'),
        isFinish: false,
        nextIndexbuf: 'i2',
      });
    },
  });

  const chunk = await source.fetchChunk('file-1', 'i1');

  assert.equal(chunk.data.toString(), 'hello');
  assert.equal(chunk.isFinish, false);
  assert.equal(chunk.nextIndexbuf, 'i2');
  assert.deepEqual(calls, [['media', '--json', 'i1', 'file-1', './config.txt']]);
});

test('ArchiveDumpMediaSource 输出非 JSON 时报 MEDIA_BAD_OUTPUT', async () => {
  const source = new ArchiveDumpMediaSource({
    binaryPath: '/bin/archive_dump',
    configPath: './config.txt',
    run: async () => 'not-json',
  });

  await assert.rejects(
    source.fetchChunk('file-1', ''),
    (error: unknown) => error instanceof MediaError && error.code === 'MEDIA_BAD_OUTPUT',
  );
});
