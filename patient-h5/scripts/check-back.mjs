/**
 * 返回路径巡检：逐页确认「用户不会被困住」。
 *
 * 判断标准：进入任一非 tab 页面后，视口内（不需要滚动）存在可点的
 * 返回/关闭/稍后再填之类控件。截图只能看出好看不好看，这个能看出会不会卡死。
 *
 * 用法：先 npm run dev:demo，再 node scripts/check-back.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5174/h5/';
const BACK_PATTERN = /返回|关闭|稍后再填|跳过|上一步/;

const results = [];

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  async function hasVisibleBack(label) {
    const handles = await page.getByRole('button', { name: BACK_PATTERN }).all();
    for (const handle of handles) {
      if (!(await handle.isVisible().catch(() => false))) continue;
      const box = await handle.boundingBox();
      if (!box) continue;
      // 必须落在首屏内，不能要求用户先滚到底才找得到
      if (box.y < 844 && box.y + box.height > 0) {
        results.push({ page: label, ok: true, control: (await handle.innerText()).trim().slice(0, 20) });
        return true;
      }
    }
    results.push({ page: label, ok: false, control: null });
    return false;
  }

  const nav = () => page.getByRole('navigation', { name: '主导航' });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('nav[aria-label="主导航"]');

  // 我的 → 隐私与授权
  await nav().getByRole('button', { name: /我的/ }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.getByRole('button', { name: '隐私与授权' }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('隐私与授权');
  await page.evaluate(() => window.scrollTo(0, 0));

  // 返回后 → 授权管理
  const back = page.getByRole('button', { name: BACK_PATTERN }).first();
  if (await back.count()) await back.click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.getByRole('button', { name: '授权管理' }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('授权管理');
  await page.evaluate(() => window.scrollTo(0, 0));

  // 返回 → 我的健康档案（建档向导）
  const back2 = page.getByRole('button', { name: BACK_PATTERN }).first();
  if (await back2.count()) await back2.click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '我的健康档案' }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('轻量建档向导');
  const exit = page.getByRole('button', { name: /稍后再填|返回/ }).first();
  if (await exit.count()) await exit.click();
  await page.waitForTimeout(300);

  // 我的健康记录
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.getByRole('button', { name: '我的健康记录' }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('记录历史');
  const back3 = page.getByRole('button', { name: BACK_PATTERN }).first();
  if (await back3.count()) await back3.click();
  await page.waitForTimeout(300);

  // 提醒与偏好
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.getByRole('button', { name: '提醒与偏好' }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('提醒偏好');
  const back4 = page.getByRole('button', { name: BACK_PATTERN }).first();
  if (await back4.count()) await back4.click();
  await page.waitForTimeout(300);

  // 计划
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: /查看计划/ }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('健康计划');
  const back5 = page.getByRole('button', { name: BACK_PATTERN }).first();
  if (await back5.count()) await back5.click();
  await page.waitForTimeout(300);

  // 团队
  await nav().getByRole('button', { name: /今天/ }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.getByRole('button', { name: '联系团队' }).click();
  await page.waitForTimeout(500);
  await hasVisibleBack('专业团队');
  const back6 = page.getByRole('button', { name: /我的专业团队|返回/ }).first();
  if (await back6.count()) await back6.click();
  await page.waitForTimeout(300);

  // 文章详情
  await nav().getByRole('button', { name: /食养/ }).click();
  await page.waitForTimeout(400);
  const feature = page.locator('.feed-card--lead');
  if (await feature.count()) {
    await feature.click();
    await page.waitForTimeout(500);
    await hasVisibleBack('文章详情');
    const back7 = page.getByRole('button', { name: BACK_PATTERN }).first();
    if (await back7.count()) await back7.click();
    await page.waitForTimeout(300);
  }

  // 日历事项弹层
  await nav().getByRole('button', { name: /日历/ }).click();
  await page.waitForTimeout(400);
  const item = page.locator('.timeline__body--button').first();
  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(400);
    await hasVisibleBack('日历事项弹层');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  await browser.close();

  let failed = 0;
  for (const row of results) {
    const mark = row.ok ? '✓' : '✗';
    if (!row.ok) failed += 1;
    process.stdout.write(`${mark} ${row.page}${row.control ? `  ← ${row.control}` : '  没有可见返回'}\n`);
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} 页有首屏可见的返回入口\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`巡检失败：${error.message}\n`);
  process.stderr.write('先确认演示服务已启动：npm run dev:demo\n');
  process.exit(1);
});
