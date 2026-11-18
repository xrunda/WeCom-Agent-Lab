import { resolve } from 'node:path';

import { createApp } from './app.ts';

const port = Number(process.env.WEBSITE_PORT ?? 8080);
const host = process.env.WEBSITE_HOST ?? '127.0.0.1';
const storeDir = resolve(process.env.WEBSITE_STORE_DIR ?? 'server/data');
const adminToken = process.env.WEBSITE_ADMIN_TOKEN ?? '';

const server = createApp({ storeDir, adminToken });
server.listen(port, host, () => {
  console.log(JSON.stringify({ event: 'server.started', host, port, storeDir }));
});
