import test from 'node:test';
import assert from 'node:assert/strict';

import { DomainStore, MemoryStoreBackend } from '../plugins/zhiban-wecom/domain.ts';
import type { StoreBackend, StoreSnapshot } from '../plugins/zhiban-wecom/domain.ts';
import type { Advisor, CustomerGroup, Draft } from '../src/c2/types.ts';

function advisor(id = 'adv_1'): Advisor {
  return { id, name: '王顾问', chatId: id, status: 'active', consecutiveMisroutes: 0 };
}

function group(roomId = 'wr1'): CustomerGroup {
  return { roomId, name: '服务群', advisorId: 'adv_1', status: 'mapped' };
}

function draft(id: string, status: Draft['status'] = 'QUEUED', queuedAt = 100): Draft {
  return {
    id,
    advisorId: 'adv_1',
    groupRoomId: 'wr1',
    groupName: '服务群',
    customerId: 'wm1',
    customerName: '张女士',
    inboundMessageId: `in_${id}`,
    inboundSummary: '摘要',
    body: '回复正文',
    ruleIds: [],
    riskLevel: 'low',
    status,
    createdAt: queuedAt,
    queuedAt,
    nextAttemptAt: queuedAt,
    pushAttempts: 0,
    verifyAttempts: 0,
  };
}

test('写入后立即可同步读取，并按队列规则排序', () => {
  const store = new DomainStore(new MemoryStoreBackend());
  store.saveAdvisor(advisor());
  store.saveGroup(group());
  store.saveDraft(draft('draft_2', 'QUEUED', 300));
  store.saveDraft(draft('draft_1', 'QUEUED', 200));
  store.saveDraft(draft('draft_3', 'PUSHED', 100));

  assert.equal(store.getAdvisor('adv_1')?.name, '王顾问');
  assert.equal(store.getGroup('wr1')?.status, 'mapped');
  assert.deepEqual(
    store.listQueued('adv_1', 1_000).map((d) => d.id),
    ['draft_1', 'draft_2'],
  );
  assert.deepEqual(
    store.listDraftsByStatus('PUSHED').map((d) => d.id),
    ['draft_3'],
  );
});

test('active 草稿可设置与清除', () => {
  const store = new DomainStore(new MemoryStoreBackend());
  store.setActiveDraft('adv_1', 'draft_1');
  assert.equal(store.getActiveDraft('adv_1'), 'draft_1');

  store.setActiveDraft('adv_1', undefined);
  assert.equal(store.getActiveDraft('adv_1'), undefined);
});

test('审计与告警按时间追加，重启后可恢复', async () => {
  const backend = new MemoryStoreBackend();
  const store = new DomainStore(backend);
  store.appendAudit({ at: 1, actor: 'pipeline', action: 'enqueue', target: 'draft_1', result: 'ok' });
  store.emitAlert({ kind: 'DOWNTIME', message: '停机', at: 2 });
  store.setMeta('archive_seq', 42);
  await store.flush();

  const restored = new DomainStore(backend);
  assert.equal(restored.listAudit().length, 1);
  assert.equal(restored.listAlerts()[0]?.kind, 'DOWNTIME');
  assert.equal(restored.getMeta<number>('archive_seq'), 42);

  // 恢复后继续追加，key 不与已有记录冲突
  restored.appendAudit({ at: 3, actor: 'pipeline', action: 'tick', target: 'draft_2', result: 'ok' });
  await restored.flush();
  assert.equal(backend.loadSnapshot().audit.length, 2);
});

test('持久化失败会回调并记录，不阻塞后续写入', async () => {
  const failures: Error[] = [];
  class FailingBackend implements StoreBackend {
    private readonly inner = new MemoryStoreBackend();
    failNext = true;

    loadSnapshot(): StoreSnapshot {
      return this.inner.loadSnapshot();
    }

    async put(): Promise<void> {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('DISK_FULL');
      }
      // 后续写入成功即可
    }

    async delete(): Promise<void> {
      // no-op
    }
  }

  const backend = new FailingBackend();
  const store = new DomainStore(backend, (error) => failures.push(error));
  store.saveAdvisor(advisor());
  await store.flush();

  assert.equal(failures.length, 1);
  assert.match(store.lastPersistError()?.message ?? '', /DISK_FULL/);

  store.saveAdvisor({ ...advisor(), name: '李顾问' });
  await store.flush();
  assert.equal(store.getAdvisor('adv_1')?.name, '李顾问');
});
