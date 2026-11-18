import { describe, expect, it } from 'vitest';

import { buildLlmsTxt, buildRobotsTxt } from '../src/llms';
import { PLAN } from '../src/plan';

const ORIGIN = 'https://zhiban.xrunda.com';

describe('llms.txt', () => {
  const text = buildLlmsTxt(ORIGIN);

  it('按 llmstxt.org 格式：一级标题 + 摘要 + 链接', () => {
    expect(text.startsWith('# 知伴健康')).toBe(true);
    expect(text).toMatch(/^> /m);
    expect(text).toContain('## 页面');
  });

  it('包含全部官网页面的绝对地址', () => {
    for (const path of ['/', '/customer-agent', '/advisor', '/management', '/scenarios', '/pricing']) {
      expect(text).toContain(`](${ORIGIN}${path === '/' ? '/' : path})`);
    }
    expect(text).toContain('/sitemap.xml');
  });

  it('价格与席位与定价页同源，且标明是参考价', () => {
    expect(text).toContain(`¥${PLAN.priceLabel}/月`);
    expect(text).toContain(`${PLAN.seats} 个顾问席位`);
    expect(text).toContain('参考价');
    expect(text).toContain(`${PLAN.archiveFee} 元 / 人 / 年`);
    expect(text).toContain('付给企业微信');
  });

  it('写清边界，避免 Agent 推断未承诺能力', () => {
    expect(text).toContain('不做诊断');
    expect(text).toContain('不向客户群自动发送消息');
    expect(text).toContain('不承诺医疗效果、无限用量');
  });

  it('没有域名时使用相对链接，便于本地预览', () => {
    const local = buildLlmsTxt(undefined);
    expect(local).toContain('](/customer-agent)');
    expect(local).not.toContain(ORIGIN);
  });
});

describe('robots.txt', () => {
  it('允许抓取并指向 sitemap', () => {
    const text = buildRobotsTxt(ORIGIN);
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Allow: /');
    expect(text).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('没有域名时不写 sitemap', () => {
    expect(buildRobotsTxt(undefined)).not.toContain('Sitemap:');
  });
});
