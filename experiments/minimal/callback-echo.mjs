#!/usr/bin/env node
/**
 * 最小回调服务器：把收到的请求原样打印并落盘，用于「先看清格式，再写解析」。
 *
 * 用法：
 *   PORT=8787 node callback-echo.mjs
 *   然后把它暴露到公网（如 cloudflared / ngrok），把 URL 填到企微后台。
 *
 * 行为：
 *   GET  : 打印 query，若含 echostr 原样返回（企微 URL 验证的第一步）
 *   POST : 打印 headers/query/body，返回 "success"
 *
 * 注意：加密模式下 echostr 是密文，不能直接原样回显。
 *       先抓包确认参数名与格式，再用 wecom-crypt.mjs 解密。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const OUT_DIR = path.resolve(process.env.CALLBACK_OUT_DIR || './out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const logFile = path.join(OUT_DIR, 'callbacks.log');
const ts = () => new Date().toISOString();

function record(entry) {
  const line = JSON.stringify(entry);
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const entry = {
      time: ts(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
      },
      body: body.slice(0, 20000),
    };
    record(entry);

    // URL 验证：明文模式下直接回显 echostr
    const echostr = url.searchParams.get('echostr');
    if (req.method === 'GET' && echostr) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(echostr);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('success');
  });
});

server.listen(PORT, () => {
  console.log(`回调抓包服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`日志: ${logFile}`);
  console.log('下一步：暴露公网地址，填到企微后台，然后观察日志里的真实格式。');
});
