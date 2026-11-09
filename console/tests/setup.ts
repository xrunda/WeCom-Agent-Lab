import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom 没有 canvas；ECharts 用空组件替换，图表交互在真实浏览器走查
vi.mock('echarts-for-react', () => ({ default: () => null }));

// Ant Design 的响应式组件依赖 matchMedia；jsdom 默认没有
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
