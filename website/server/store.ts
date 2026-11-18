import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DemoRequestInput } from '../src/lib/demo.ts';

export interface DemoRequestRecord extends DemoRequestInput {
  id: string;
  createdAt: string;
  source: 'website-v1';
  status: 'new';
  fingerprint: string;
  duplicateOf: string | null;
}

export interface DemoStoreOptions {
  dir: string;
  now?: () => Date;
}

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

function fingerprintOf(input: DemoRequestInput): string {
  return createHash('sha256')
    .update(`${input.orgName}\u0000${input.contactName}\u0000${input.contact}`)
    .digest('hex');
}

async function ensureFile(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await appendFile(file, '', { mode: 0o600 });
  } catch {
    // 文件已存在时 appendFile 仍会成功；权限由首次创建决定
  }
}

export class DemoStore {
  private readonly file: string;
  private readonly now: () => Date;

  constructor(options: DemoStoreOptions) {
    this.file = join(options.dir, 'demo-requests.jsonl');
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await ensureFile(this.file);
  }

  async list(): Promise<DemoRequestRecord[]> {
    let raw = '';
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const records: DemoRequestRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as DemoRequestRecord);
      } catch {
        // 损坏的行不阻断其余记录
      }
    }
    return records;
  }

  async add(input: DemoRequestInput): Promise<{ record: DemoRequestRecord; duplicate: boolean }> {
    const fingerprint = fingerprintOf(input);
    const cutoff = this.now().getTime() - DUPLICATE_WINDOW_MS;
    const existing = (await this.list()).find(
      (item) => item.fingerprint === fingerprint && Date.parse(item.createdAt) >= cutoff,
    );
    if (existing) {
      return { record: existing, duplicate: true };
    }

    const id = `req_${this.now().getTime().toString(36)}_${randomBytes(4).toString('hex')}`;
    const record: DemoRequestRecord = {
      ...input,
      id,
      createdAt: this.now().toISOString(),
      source: 'website-v1',
      status: 'new',
      fingerprint,
      duplicateOf: null,
    };
    await appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return { record, duplicate: false };
  }
}

export function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
