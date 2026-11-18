import { writeFile } from 'node:fs/promises';

import { buildLlmsTxt, buildRobotsTxt } from '../src/llms.ts';

// 默认写生产域名，保证本地构建与线上文件一致；换域名时用 VITE_SITE_ORIGIN 覆盖。
const origin = process.env.VITE_SITE_ORIGIN?.trim() || 'https://zhiban.xrunda.com';

await writeFile('public/llms.txt', buildLlmsTxt(origin), 'utf8');
await writeFile('public/robots.txt', buildRobotsTxt(origin), 'utf8');

console.log(`已生成 public/llms.txt 与 public/robots.txt（${origin}）`);
