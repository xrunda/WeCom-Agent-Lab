#!/usr/bin/env node
/**
 * 企业微信回调抓包/解包工具（标准 AES 加密方案）。
 *
 * 用途：
 *   1) 先跑 callback-echo.mjs 原样抓取请求，确认目标回调到底用 XML 还是 JSON、
 *      query 参数叫什么，再决定怎么解。
 *   2) 用本文件的 decrypt 解开 echostr / Encrypt 字段。
 *
 * 只实现标准企微加密方案：
 *   AES-256-CBC，key = Base64Decode(EncodingAESKey + "=")，IV = key[:16]
 *   明文 = random(16) + msg_len(4, 大端) + msg + receiveid
 *   PKCS#7 填充，签名 = sha1(sort(token, timestamp, nonce, encrypt).join(""))
 *
 * 注意：这是通用工具，未在真实回调上验证过。第一次接入请先抓包比对。
 *
 * 用法：
 *   node wecom-crypt.mjs decrypt <EncodingAESKey> <Base64密文>
 *   node wecom-crypt.mjs sign <token> <timestamp> <nonce> <encrypt>
 */

import crypto from 'node:crypto';

export function decodeAesKey(encodingAesKey) {
  if (!encodingAesKey || encodingAesKey.length !== 43) {
    throw new Error('EncodingAESKey 应为 43 个字符');
  }
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) throw new Error(`解码后 key 长度为 ${key.length}，应为 32`);
  return key;
}

function pkcs7Unpad(buf) {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32 || pad > buf.length) return buf;
  return buf.subarray(0, buf.length - pad);
}

export function decrypt(ciphertextBase64, encodingAesKey) {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(
    Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, 'base64')), decipher.final()]),
  );
  if (plain.length < 20) throw new Error('明文长度不足，密文或密钥可能不对');
  const msgLen = plain.readUInt32BE(16);
  if (20 + msgLen > plain.length) throw new Error('消息长度字段越界，密钥可能不对');
  return {
    msg: plain.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: plain.subarray(20 + msgLen).toString('utf8'),
  };
}

export function signature(token, timestamp, nonce, encrypt) {
  const parts = [token, String(timestamp), String(nonce), encrypt].sort();
  return crypto.createHash('sha1').update(parts.join('')).digest('hex');
}

export function verifySignature(token, timestamp, nonce, encrypt, expected) {
  const actual = signature(token, timestamp, nonce, encrypt);
  const a = Buffer.from(actual);
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- CLI ----
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'decrypt') {
      const [key, data] = rest;
      if (!key || !data) throw new Error('用法: decrypt <EncodingAESKey> <Base64密文>');
      const out = decrypt(data, key);
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'sign') {
      const [token, timestamp, nonce, encrypt] = rest;
      if (!token || !timestamp || !nonce || !encrypt) {
        throw new Error('用法: sign <token> <timestamp> <nonce> <encrypt>');
      }
      console.log(signature(token, timestamp, nonce, encrypt));
    } else {
      console.error('命令: decrypt | sign');
      process.exit(1);
    }
  } catch (err) {
    console.error('错误:', err.message);
    process.exit(1);
  }
}
