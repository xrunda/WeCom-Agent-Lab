import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/app.ts';

const TOKEN = 'test-admin-token-0123456789abcdef';
let dir = '';
let server: ReturnType<typeof createApp>;
let base = '';
const logs: string[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zhiban-website-test-'));
  server = createApp({
    storeDir: dir,
    adminToken: TOKEN,
    distDir: dir,
    logger: (line) => logs.push(line),
    rateLimitPerHour: 1000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address) base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

test('缺项返回字段错误', async () => {
  const res = await fetch(`${base}/api/demo-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { fields: Record<string, string> } };
  assert.equal(body.error.fields.orgName, '请填写机构名称');
  assert.equal(body.error.fields.contactName, '请填写联系人');
  assert.equal(body.error.fields.contact, '请填写联系方式');
});

test('联系方式支持手机、邮箱、微信号', async () => {
  for (const contact of ['13800138000', 'hello@example.com', 'wxid_demo01']) {
    const res = await fetch(`${base}/api/demo-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName: '示例机构', contactName: '陈顾问', contact }),
    });
    assert.equal(res.status, 200, contact);
  }
});

test('成功入库，接收端可查，且不返回联系方式', async () => {
  const contact = '13900139000';
  const res = await fetch(`${base}/api/demo-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgName: '康和健康管理',
      contactName: '周主管',
      contact,
      topic: '想先看回访提醒和餐食记录',
    }),
  });
  assert.equal(res.status, 200);
  const created = (await res.json()) as { ok: boolean; id: string };
  assert.equal(created.ok, true);

  const admin = await fetch(`${base}/api/demo-requests`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(admin.status, 200);
  const body = (await admin.json()) as { records: Array<{ contact: string; orgName: string }> };
  const record = body.records.find((item) => item.contact === contact);
  assert.ok(record);
  assert.equal(record?.orgName, '康和健康管理');

  const raw = await readFile(join(dir, 'demo-requests.jsonl'), 'utf8');
  assert.match(raw, /康和健康管理/);
});

test('重复提交在 10 分钟内返回同一条', async () => {
  const payload = { orgName: '同一家机构', contactName: '同一联系人', contact: 'same@example.com' };
  const first = await fetch(`${base}/api/demo-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const firstBody = (await first.json()) as { id: string };
  const second = await fetch(`${base}/api/demo-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { id: string; duplicate?: boolean };
  assert.equal(secondBody.id, firstBody.id);
  assert.equal(secondBody.duplicate, true);
});

test('蜜罐字段命中时不落库', async () => {
  const beforeCount = await countStore();
  const res = await fetch(`${base}/api/demo-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgName: '机器人机构',
      contactName: '机器人',
      contact: 'bot@example.com',
      website: 'https://spam.example.com',
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(await countStore(), beforeCount);
});

test('未授权接收端返回 401，未配置令牌返回 503', async () => {
  const denied = await fetch(`${base}/api/demo-requests`);
  assert.equal(denied.status, 401);

  const noToken = createApp({ storeDir: dir, adminToken: '', distDir: dir, logger: () => {} });
  await new Promise<void>((resolve) => noToken.listen(0, '127.0.0.1', resolve));
  const address = noToken.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/demo-requests`);
  assert.equal(res.status, 503);
  await new Promise<void>((resolve) => noToken.close(() => resolve()));
});

test('日志不含表单内容', async () => {
  const secret = 'log-secret@example.com';
  await fetch(`${base}/api/demo-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgName: '日志测试机构', contactName: '日志测试', contact: secret }),
  });
  const joined = logs.join('\n');
  assert.equal(joined.includes(secret), false);
  assert.equal(joined.includes('日志测试机构'), false);
});

async function countStore(): Promise<number> {
  const raw = await readFile(join(dir, 'demo-requests.jsonl'), 'utf8').catch(() => '');
  return raw.split('\n').filter((line) => line.trim()).length;
}
