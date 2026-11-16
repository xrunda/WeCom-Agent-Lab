/**
 * zhiban-advisor 的会话记录领域存储（#167 §4）。
 *
 * 会话 id 由 advisorId 推导（`zhiban-advisor-<advisorId>`，跨重启稳定），
 * 这里把映射落盘一份，便于观察与未来扩展；读取同步来自内存镜像。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { AdvisorSessionRecord } from '../../src/p1/advisor/types.ts';

export const advisorDomain = defineDomain({
  name: 'zhiban_advisor',
  version: 1,
  tables: {
    sessions: domainTable(z.object({ advisorId: z.string().min(1) }).passthrough()),
  },
});

export type AdvisorDomainHandle = Domain<typeof advisorDomain>;

export interface AdvisorSessionBackend {
  load(): Array<[string, AdvisorSessionRecord]>;
  put(key: string, value: AdvisorSessionRecord): Promise<void>;
}

export class DomainAdvisorSessionBackend implements AdvisorSessionBackend {
  private readonly table: {
    entries(): IterableIterator<[string, unknown]>;
    put(key: string, value: unknown): Promise<void>;
  };

  constructor(domain: AdvisorDomainHandle) {
    this.table = domain.table('sessions') as unknown as {
      entries(): IterableIterator<[string, unknown]>;
      put(key: string, value: unknown): Promise<void>;
    };
  }

  load(): Array<[string, AdvisorSessionRecord]> {
    return [...this.table.entries()].map(
      ([key, value]) => [key, value as AdvisorSessionRecord] as [string, AdvisorSessionRecord],
    );
  }

  put(key: string, value: AdvisorSessionRecord): Promise<void> {
    return this.table.put(key, value);
  }
}

/** 测试用内存后端 */
export class MemoryAdvisorSessionBackend implements AdvisorSessionBackend {
  readonly data = new Map<string, AdvisorSessionRecord>();

  load(): Array<[string, AdvisorSessionRecord]> {
    return [...this.data.entries()].map(
      ([key, value]) => [key, structuredClone(value)] as [string, AdvisorSessionRecord],
    );
  }

  async put(key: string, value: AdvisorSessionRecord): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

export class AdvisorSessionStore {
  private readonly sessions = new Map<string, AdvisorSessionRecord>();
  private readonly backend: AdvisorSessionBackend;
  private chain: Promise<void> = Promise.resolve();

  constructor(backend: AdvisorSessionBackend) {
    this.backend = backend;
    for (const [key, value] of backend.load()) this.sessions.set(key, value);
  }

  get(advisorId: string): AdvisorSessionRecord | undefined {
    return this.sessions.get(advisorId);
  }

  list(): AdvisorSessionRecord[] {
    return [...this.sessions.values()];
  }

  save(record: AdvisorSessionRecord): void {
    this.sessions.set(record.advisorId, record);
    this.chain = this.chain.then(() =>
      this.backend.put(record.advisorId, structuredClone(record)),
    );
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
