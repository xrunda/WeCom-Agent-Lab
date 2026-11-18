import { writeFile } from 'node:fs/promises';

const origin = process.env.VITE_SITE_ORIGIN?.trim();
if (!origin) {
  console.error('未设置 VITE_SITE_ORIGIN；预览版本不生成 sitemap。');
  process.exit(1);
}

const paths = ['/', '/customer-agent', '/advisor', '/management', '/scenarios', '/demo'];
const base = origin.replace(/\/+$/, '');
const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map(
    (path) =>
      `  <url><loc>${base}${path === '/' ? '/' : path}</loc><changefreq>monthly</changefreq></url>`,
  )
  .join('\n')}
</urlset>
`;
await writeFile('public/sitemap.xml', body, 'utf8');
console.log(`已生成 public/sitemap.xml（${base}）`);
