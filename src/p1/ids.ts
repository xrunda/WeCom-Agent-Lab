/**
 * P1 业务实体 id（docs/P1-data-model.md §1.1）。
 *
 * 格式 `<前缀>_<26 位小写 ULID>`：48 位时间 + 80 位随机，Crockford base32。
 * 前端不得解析 id 内部结构；这里只在服务端生成。
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export type IdFactory = (prefix: string) => string;

export function newId(prefix: string, now = Date.now(), random = Math.random): string {
  let time = '';
  let value = Math.max(0, Math.floor(now));
  for (let index = 0; index < 10; index += 1) {
    time = ALPHABET[value % 32] + time;
    value = Math.floor(value / 32);
  }
  let suffix = '';
  for (let index = 0; index < 16; index += 1) {
    suffix += ALPHABET[Math.floor(random() * 32)] ?? '0';
  }
  return `${prefix}_${time}${suffix}`;
}

export function idFactory(now: () => number, random = Math.random): IdFactory {
  return (prefix) => newId(prefix, now(), random);
}
