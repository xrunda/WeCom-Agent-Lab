import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { validateDemoRequest } from '../src/lib/demo.ts';
import { DemoStore, tokensEqual } from './store.ts';

const MAX_BODY = 32 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

export interface AppOptions {
  storeDir: string;
  adminToken?: string;
  distDir?: string;
  now?: () => Date;
  rateLimitPerHour?: number;
  trustProxy?: boolean;
  logger?: (line: string) => void;
}

interface RateEntry {
  times: number[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) {
      const error = new Error('BODY_TOO_LARGE');
      (error as Error & { code?: string }).code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const error = new Error('INVALID_JSON');
    (error as Error & { code?: string }).code = 'INVALID_JSON';
    throw error;
  }
}

function safePath(distDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  const normalized = normalize(decoded).replace(/^([/\\])+/, '');
  const target = resolve(distDir, normalized);
  if (!target.startsWith(distDir.endsWith(sep) ? distDir : `${distDir}${sep}`) && target !== distDir) {
    return null;
  }
  return target;
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
  urlPath: string,
): Promise<void> {
  const isHtmlRoute = !extname(urlPath);
  let target = safePath(distDir, urlPath) ?? '';
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
  } catch {
    if (!isHtmlRoute) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    target = join(distDir, 'index.html');
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

export function createApp(options: AppOptions): Server {
  const distDir = resolve(options.distDir ?? 'dist');
  const store = new DemoStore({ dir: options.storeDir, now: options.now });
  const logger = options.logger ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const rateLimit = options.rateLimitPerHour ?? 5;
  const trustProxy = options.trustProxy ?? false;
  const rates = new Map<string, RateEntry>();
  const adminToken = options.adminToken?.trim() ?? '';

  const limited = (ip: string): boolean => {
    const cutoff = now().getTime() - RATE_WINDOW_MS;
    const entry = rates.get(ip) ?? { times: [] };
    entry.times = entry.times.filter((time) => time >= cutoff);
    if (entry.times.length >= rateLimit) {
      rates.set(ip, entry);
      return true;
    }
    entry.times.push(now().getTime());
    rates.set(ip, entry);
    return false;
  };

  store.init().catch((error: unknown) => {
    logger(JSON.stringify({ event: 'store.init.failed', message: String(error) }));
  });

  const server = createServer((req, res) => {
    const started = Date.now();
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    const ip = clientIp(req, trustProxy);

    res.on('finish', () => {
      logger(
        JSON.stringify({
          method: req.method,
          path: urlPath,
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      );
    });

    if (req.method === 'GET' && urlPath === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (urlPath === '/api/demo-requests' && req.method === 'POST') {
      if (limited(ip)) {
        sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: '提交过于频繁，请稍后重试。' } });
        return;
      }

      void (async () => {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (error) {
          const code = (error as Error & { code?: string }).code;
          if (code === 'BODY_TOO_LARGE') {
            sendJson(res, 413, { error: { code, message: '提交内容过大。' } });
          } else {
            sendJson(res, 400, { error: { code: 'INVALID_JSON', message: '提交格式不正确。' } });
          }
          return;
        }

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: { code: 'INVALID_JSON', message: '提交格式不正确。' } });
          return;
        }

        const raw = body as Record<string, unknown>;
        // 蜜罐字段：机器人填写后直接返回成功，不落库
        if (typeof raw.website === 'string' && raw.website.trim()) {
          sendJson(res, 200, { ok: true });
          return;
        }

        const { data, errors } = validateDemoRequest(raw);
        if (Object.keys(errors).length > 0) {
          sendJson(res, 400, {
            error: { code: 'VALIDATION_FAILED', message: '请检查表单', fields: errors },
          });
          return;
        }

        try {
          const { record, duplicate } = await store.add(data);
          logger(JSON.stringify({ event: 'demo.request', id: record.id, duplicate }));
          sendJson(res, 200, { ok: true, id: record.id, duplicate });
        } catch {
          logger(JSON.stringify({ event: 'demo.request.failed' }));
          sendJson(res, 500, { error: { code: 'STORE_FAILED', message: '预约暂未提交成功，请稍后重试。' } });
        }
      })();
      return;
    }

    if (urlPath === '/api/demo-requests' && req.method === 'GET') {
      if (!adminToken || adminToken.length < 24) {
        sendJson(res, 503, { error: { code: 'ADMIN_DISABLED', message: '接收端尚未配置。' } });
        return;
      }
      const auth = req.headers.authorization ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!tokensEqual(provided, adminToken)) {
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '未授权。' } });
        return;
      }
      void (async () => {
        const limitRaw = (req.url ?? '').includes('limit=') ? Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit')) : 100;
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
        const records = (await store.list())
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map(({ fingerprint: _fingerprint, ...record }) => record);
        sendJson(res, 200, { ok: true, count: records.length, records });
      })();
      return;
    }

    if (urlPath.startsWith('/api/')) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      void serveStatic(req, res, distDir, urlPath);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
  });

  return server;
}
