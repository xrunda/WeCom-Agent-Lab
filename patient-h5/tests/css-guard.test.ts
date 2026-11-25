/**
 * 样式回归护栏：图片类名不得自带 width/height:100%。
 *
 * 之前 `.asset-media` 里写了 width/height:100%，覆盖了各卡片槽位的固定宽度，
 * 图片撑满整行、同一行的文字被挤成一列（整页竖排）。这条把它钉死。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/** 取出某个选择器对应的规则体（只取第一条） */
function ruleBody(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  if (index < 0) return '';
  const end = css.indexOf('}', index);
  return css.slice(index, end);
}

describe('样式护栏', () => {
  it('.asset-media 不设置宽高（尺寸交给各槽位类）', () => {
    const body = ruleBody('.asset-media');
    expect(body).not.toMatch(/width:\s*100%/);
    expect(body).not.toMatch(/height:\s*100%/);
    expect(body).toMatch(/object-fit:\s*cover/);
  });

  it('不再跟随系统深色主题（设计稿只有米白一套）', () => {
    expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
  });
});
