/**
 * 食养「听一听」：服务端火山 TTS 音频播放（真实模式）。
 *
 * 这里只验证前端接线：能力开关来自 /articles 的 audioAvailable，
 * 点击后请求 /articles/{id}/audio，停止时释放 audio 元素。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NurturePage } from '../src/pages/NurturePage.tsx';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ARTICLE = {
  id: 'art_1',
  category: 'classics_life',
  title: '早餐，怎样吃得更丰富？',
  summary: '几种家常搭配思路。',
  coverUrl: null,
  publishedAt: 0,
  seasonTerm: null,
  microAction: '明天早餐加一种蔬菜。',
  scenarioTags: ['breakfast'],
};

function mockApi(audioAvailable: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifesto')) {
        return Promise.resolve(jsonResponse(200, { version: 1, slogans: [], sections: [] }));
      }
      if (url.endsWith('/articles')) {
        return Promise.resolve(jsonResponse(200, { items: [ARTICLE], audioAvailable }));
      }
      if (url.endsWith('/profile')) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    }),
  );
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    return Promise.resolve();
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeAudio.instances = [];
});

describe('NurturePage 听一听（火山 TTS）', () => {
  it('服务端开启朗读时请求音频接口，再次点击停止并释放', async () => {
    mockApi(true);
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
    const user = userEvent.setup();
    render(<NurturePage />);

    const listen = await screen.findByRole('button', { name: /听一听/ });
    await user.click(listen);

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]!.src).toBe('/zhiban/h5/articles/art_1/audio');
    await waitFor(() => expect(screen.getByRole('button', { name: /停止朗读/ })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /停止朗读/ }));
    expect(FakeAudio.instances[0]!.pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /听一听/ })).toBeInTheDocument();
  });

  it('服务端未配置 TTS 时不渲染按钮', async () => {
    mockApi(false);
    render(<NurturePage />);
    await screen.findByText('早餐，怎样吃得更丰富？');
    expect(screen.queryByRole('button', { name: /听一听/ })).toBeNull();
  });

  it('音频加载失败时给出可读提示，不把按钮卡在「停止」', async () => {
    mockApi(true);
    class FailingAudio extends FakeAudio {
      play(): Promise<void> {
        return Promise.reject(new Error('decode'));
      }
    }
    vi.stubGlobal('Audio', FailingAudio as unknown as typeof Audio);
    const user = userEvent.setup();
    render(<NurturePage />);

    await user.click(await screen.findByRole('button', { name: /听一听/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('朗读暂时放不出来'));
    expect(screen.getByRole('button', { name: /听一听/ })).toBeInTheDocument();
  });
});
