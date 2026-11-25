/**
 * 患者端 H5 截图脚本（开发自查用）。
 *
 * 为什么需要它：样式塌陷（图片撑破、文字竖排）跑单测和 tsc 都发现不了，
 * 改完必须自己看一眼渲染结果。
 *
 * 用法：
 *   1. 另开终端跑演示服务：npm run dev:demo
 *   2. npm run shots
 *   3. 截图输出到 screenshots/<页面>.png，直接打开看
 *
 * 只截演示模式（VITE_API_MODE=demo）的本地页面，不连真实数据。
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5174/h5/';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../screenshots');

/** iPhone 15 Pro 尺寸；页面按 390 宽设计 */
const VIEWPORT = { width: 390, height: 844 };
const DEVICE_SCALE = 2;

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  const shot = async (name, options = {}) => {
    await page.waitForTimeout(350);
    await page.screenshot({
      path: resolve(OUT, `${name}.png`),
      fullPage: options.fullPage ?? false,
    });
    process.stdout.write(`  ✓ ${name}.png\n`);
  };

  process.stdout.write(`打开 ${BASE}\n`);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // 演示模式自动进入主应用
  await page.waitForSelector('nav[aria-label="主导航"]', { timeout: 15000 });

  await shot('01-today');

  // 今天页往下滚，检查快捷记录 / 相关食养 / 团队卡
  await page.evaluate(() => window.scrollTo(0, 700));
  await shot('02-today-lower');
  await page.evaluate(() => window.scrollTo(0, 0));

  // 日历
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /日历/ }).click();
  await page.waitForTimeout(400);
  await shot('03-calendar');

  // 食养
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /食养/ }).click();
  await page.waitForTimeout(400);
  await shot('04-nurture');
  await page.evaluate(() => window.scrollTo(0, 800));
  await shot('05-nurture-lower');
  await page.evaluate(() => window.scrollTo(0, 0));

  // 我的
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /我的/ }).click();
  await page.waitForTimeout(400);
  await shot('06-me');

  // 计划
  const planButton = page.getByRole('button', { name: /查看计划/ });
  if (await planButton.count()) {
    await planButton.first().click();
    await page.waitForTimeout(500);
    await shot('07-plan');
    await page.evaluate(() => window.scrollTo(0, 800));
    await shot('08-plan-lower');
    await page.getByRole('button', { name: /返回/ }).first().click();
    await page.waitForTimeout(300);
  }

  // 团队：回到今天页再点「联系团队」
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /今天/ }).click();
  await page.waitForTimeout(300);
  const teamButton = page.getByRole('button', { name: '联系团队' });
  if (await teamButton.count()) {
    await page.evaluate(() => window.scrollTo(0, 2000));
    await teamButton.first().click();
    await page.waitForTimeout(500);
    await shot('09-team');
    await page.evaluate(() => window.scrollTo(0, 700));
    await shot('10-team-lower');
  }

  // 记录面板：今天页「拍照记餐」
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('nav[aria-label="主导航"]');
  await page.evaluate(() => window.scrollTo(0, 900));
  const mealButton = page.getByRole('button', { name: /拍照记餐/ });
  if (await mealButton.count()) {
    await mealButton.first().click();
    await page.waitForTimeout(400);
    await shot('11-record-sheet');
  }

  await browser.close();

  if (errors.length > 0) {
    process.stdout.write(`\n控制台错误 ${errors.length} 条：\n`);
    for (const message of errors.slice(0, 10)) process.stdout.write(`  - ${message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\n控制台无错误\n');
  }
  process.stdout.write(`截图目录：${OUT}\n`);
}

main().catch((error) => {
  process.stderr.write(`截图失败：${error.message}\n`);
  process.stderr.write('先确认演示服务已启动：npm run dev:demo\n');
  process.exit(1);
});
