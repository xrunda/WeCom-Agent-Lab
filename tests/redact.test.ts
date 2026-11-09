import test from 'node:test';
import assert from 'node:assert/strict';

import { describeMessageMeta, senderType, tailId } from '../src/c2/redact.ts';

test('tailId 只保留尾号，空值返回占位符', () => {
  assert.equal(tailId('wrGROUP_ABCDEF123456'), '…123456');
  assert.equal(tailId('short'), 'short');
  assert.equal(tailId(''), '-');
  assert.equal(tailId(undefined), '-');
});

test('senderType 只暴露类型，不暴露 userid', () => {
  assert.equal(senderType('LiGuang', 'send'), 'employee');
  assert.equal(senderType('wmCUSTOMER_ABCDEF', 'recv'), 'external');
  assert.equal(senderType('unknown_user'), 'unknown');
  assert.equal(senderType(undefined), 'unknown');
});

test('describeMessageMeta 只输出元数据', () => {
  const line = describeMessageMeta({
    msgid: 'msgid_CUSTOMER_123456',
    roomid: 'wrGROUP_ABCDEF123456',
    msgtype: 'text',
    from: 'wmCUSTOMER_ABCDEF',
    action: 'recv',
  });

  assert.equal(line, 'msgid=…123456 msgtype=text room=…123456 sender=external');
  assert.ok(!line.includes('msgid_CUSTOMER_123456'));
  assert.ok(!line.includes('wrGROUP_ABCDEF123456'));
  assert.ok(!line.includes('wmCUSTOMER_ABCDEF'));
});

test('单聊不输出 roomid', () => {
  const line = describeMessageMeta({
    msgid: 'msgid_123456',
    roomid: '',
    msgtype: 'text',
    from: 'LiGuang',
    action: 'send',
  });

  assert.equal(line, 'msgid=…123456 msgtype=text room=单聊 sender=employee');
});
