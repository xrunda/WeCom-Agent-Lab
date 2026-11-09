import {
  C2Service,
  FakeClock,
  MemoryStore,
  MockArchive,
  MockBot,
} from '../src/c2/index.ts';
import type { ServiceConfig } from '../src/c2/service.ts';
import type { Draft } from '../src/c2/types.ts';

export function makeDraft(overrides: Partial<Draft> = {}): Draft {
  const now = overrides.createdAt ?? 0;
  return {
    id: 'd1',
    advisorId: 'a1',
    groupRoomId: 'room_1',
    groupName: '群 1',
    customerId: 'c1',
    customerName: '客户 1',
    inboundMessageId: 'in_1',
    inboundSummary: '客户的问题摘要',
    body: '这是回复给客户的正文内容，足够长以便进行模糊匹配。',
    ruleIds: [],
    riskLevel: 'low',
    status: 'QUEUED',
    createdAt: now,
    queuedAt: now,
    nextAttemptAt: now,
    pushAttempts: 0,
    verifyAttempts: 0,
    ...overrides,
  };
}

export function setup(config?: ServiceConfig): {
  clock: FakeClock;
  store: MemoryStore;
  bot: MockBot;
  archive: MockArchive;
  service: C2Service;
} {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new MemoryStore();
  const bot = new MockBot(clock);
  const archive = new MockArchive();
  const service = new C2Service({ store, bot, archive, clock, config });
  return { clock, store, bot, archive, service };
}

export function bindDefaultAdvisor(
  service: C2Service,
  input: { advisorId?: string; chatId?: string | null } = {},
): string {
  const advisorId = input.advisorId ?? 'a1';
  service.addAdvisor({
    id: advisorId,
    name: '测试顾问',
    chatId: input.chatId === null ? undefined : (input.chatId ?? 'chat_a1'),
  });
  return advisorId;
}
