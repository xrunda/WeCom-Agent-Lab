import type {
  Advisor,
  Alert,
  ArchivedInbound,
  AuditEvent,
  CardPayload,
  CustomerGroup,
  Draft,
  DraftStatus,
  SentMessage,
  TextPayload,
} from './types.ts';
import type { ArchivePort, BotPort, BotSentRecord, Clock, Store } from './ports.ts';

export class FakeClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(t: number): void {
    this.t = t;
  }
}

export class MemoryStore implements Store {
  private advisors = new Map<string, Advisor>();
  private groups = new Map<string, CustomerGroup>();
  private drafts = new Map<string, Draft>();
  private active = new Map<string, string>();
  private auditEvents: AuditEvent[] = [];
  private alerts: Alert[] = [];

  saveAdvisor(advisor: Advisor): void {
    this.advisors.set(advisor.id, advisor);
  }

  getAdvisor(id: string): Advisor | undefined {
    return this.advisors.get(id);
  }

  listAdvisors(): Advisor[] {
    return [...this.advisors.values()];
  }

  saveGroup(group: CustomerGroup): void {
    this.groups.set(group.roomId, group);
  }

  getGroup(roomId: string): CustomerGroup | undefined {
    return this.groups.get(roomId);
  }

  listGroups(): CustomerGroup[] {
    return [...this.groups.values()];
  }

  saveDraft(draft: Draft): void {
    this.drafts.set(draft.id, draft);
  }

  getDraft(id: string): Draft | undefined {
    return this.drafts.get(id);
  }

  listDrafts(): Draft[] {
    return [...this.drafts.values()];
  }

  listQueued(advisorId: string, now: number): Draft[] {
    return [...this.drafts.values()]
      .filter((d) => d.advisorId === advisorId && d.status === 'QUEUED' && d.nextAttemptAt <= now)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  listDraftsByStatus(status: DraftStatus): Draft[] {
    return [...this.drafts.values()].filter((d) => d.status === status);
  }

  getActiveDraft(advisorId: string): string | undefined {
    return this.active.get(advisorId);
  }

  setActiveDraft(advisorId: string, draftId: string | undefined): void {
    if (draftId === undefined) this.active.delete(advisorId);
    else this.active.set(advisorId, draftId);
  }

  appendAudit(event: AuditEvent): void {
    this.auditEvents.push(event);
  }

  listAudit(): AuditEvent[] {
    return [...this.auditEvents];
  }

  emitAlert(alert: Alert): void {
    this.alerts.push(alert);
  }

  listAlerts(): Alert[] {
    return [...this.alerts];
  }
}

export class MockBot implements BotPort {
  readonly sent: BotSentRecord[] = [];
  /** 接下来 N 次发送卡片失败 */
  failCardTimes = 0;
  /** 接下来 N 次发送文本失败 */
  failTextTimes = 0;

  private clock: Clock;
  private seq = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async sendCard(chatId: string, card: CardPayload): Promise<{ messageId: string }> {
    if (this.failCardTimes > 0) {
      this.failCardTimes -= 1;
      throw new Error('MOCK_CARD_FAILURE');
    }
    const messageId = `card_${++this.seq}`;
    this.sent.push({ chatId, kind: 'card', message: card, messageId, at: this.clock.now() });
    return { messageId };
  }

  async sendText(chatId: string, text: string): Promise<{ messageId: string }> {
    if (this.failTextTimes > 0) {
      this.failTextTimes -= 1;
      throw new Error('MOCK_TEXT_FAILURE');
    }
    const messageId = `text_${++this.seq}`;
    const payload: TextPayload = { msgtype: 'text', text: { content: text } };
    this.sent.push({ chatId, kind: 'text', message: payload, messageId, at: this.clock.now() });
    return { messageId };
  }

  cards(): BotSentRecord[] {
    return this.sent.filter((s) => s.kind === 'card');
  }

  texts(): BotSentRecord[] {
    return this.sent.filter((s) => s.kind === 'text');
  }
}

export class MockArchive implements ArchivePort {
  readonly messages: SentMessage[] = [];

  add(message: SentMessage): void {
    this.messages.push(message);
  }

  async listSentMessages(params: {
    fromUser: string;
    since: number;
    until: number;
  }): Promise<SentMessage[]> {
    return this.messages.filter(
      (m) =>
        m.from === params.fromUser && m.msgtime >= params.since && m.msgtime <= params.until,
    );
  }

  async listInboundMessages(params: {
    roomIds: string[];
    excludeSender: string;
    since: number;
    until: number;
  }): Promise<ArchivedInbound[]> {
    const rooms = new Set(params.roomIds);
    return this.messages
      .filter(
        (m) =>
          rooms.has(m.roomid) &&
          m.from !== params.excludeSender &&
          m.msgtime >= params.since &&
          m.msgtime <= params.until,
      )
      .map((m) => ({
        msgid: m.msgid,
        roomid: m.roomid,
        from: m.from,
        text: m.text,
        msgtime: m.msgtime,
      }));
  }
}
