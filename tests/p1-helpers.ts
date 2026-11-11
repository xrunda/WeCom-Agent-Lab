import { FakeClock } from '../src/c2/memory.ts';
import type { CustomerGroup, Draft, RiskLevel, VerifyOutcome } from '../src/c2/types.ts';
import { MemoryPatientStore } from '../src/p1/patient-store.ts';
import type { PatientSnapshot } from '../src/p1/patient-store.ts';
import { PatientService } from '../src/p1/patient-service.ts';
import type { PatientBridge, PatientSessionPort, ReviseAgentDraftInput } from '../src/p1/session-port.ts';
import { PatientAgentRuntime } from '../src/p1/runtime.ts';
import type { DraftGuardPort } from '../src/p1/runtime.ts';
import type {
  AgentCapabilities,
  AgentContentPart,
  Patient,
  PatientMemoryPort,
  PatientSessionRecord,
  TenantAgentSettings,
} from '../src/p1/types.ts';

export const TENANT = 'tn_test';

export const SETTINGS: TenantAgentSettings = {
  agentName: '小安',
  patientTerm: '患者',
  tone: '亲切、专业、简洁',
  advisorName: '王顾问',
  advisorId: 'adv_1',
};

export function setupPatient(options: { requireConsentForTurn?: boolean } = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new MemoryPatientStore();
  const service = new PatientService(store, clock, {
    tenantId: TENANT,
    requireConsentForTurn: options.requireConsentForTurn,
  });
  service.upsertAdvisor({
    id: 'adv_1',
    wecomUserId: 'wang.guwen',
    name: '王顾问',
    chatBound: true,
  });
  return { clock, store, service };
}

export class FakeSessions implements PatientSessionPort {
  readonly prompts: Array<{ sessionId: string; text: string; content: AgentContentPart[] }> = [];
  readonly contexts: Array<{ sessionId: string; text: string }> = [];
  readonly ensured: string[] = [];
  outcome: 'idle' | 'timeout' = 'idle';
  failPrompt = false;
  onPrompt?: (sessionId: string, text: string) => Promise<void> | void;

  async ensure(patient: Patient): Promise<PatientSessionRecord> {
    this.ensured.push(patient.id);
    return {
      patientId: patient.id,
      sessionId: `session_${patient.id}`,
      workspacePath: `/tmp/zhiban-ws/${patient.id}`,
      createdAt: 0,
    };
  }

  async prompt(sessionId: string, input: string | AgentContentPart[]): Promise<void> {
    const content: AgentContentPart[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    const text = content
      .filter((part): part is Extract<AgentContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    this.prompts.push({ sessionId, text, content });
    if (this.failPrompt) throw new Error('MODEL_DOWN');
    await this.onPrompt?.(sessionId, text);
  }

  async injectContext(sessionId: string, text: string): Promise<void> {
    this.contexts.push({ sessionId, text });
  }

  async waitIdle(): Promise<'idle' | 'timeout'> {
    return this.outcome;
  }
}

export interface FakeEnqueue {
  advisorId: string;
  groupRoomId: string;
  patientId: string;
  customerId: string;
  customerName: string;
  body: string;
  riskLevel: RiskLevel;
  ruleIds?: string[];
  ruleNames?: string[];
  source: 'inbound' | 'proactive';
  fallback: boolean;
  inboundSummary: string;
  inboundMessageIds: string[];
  mediaIds: string[];
  mediaKinds?: string[];
  citedMemoryIds: string[];
  citedKnowledgeIds: string[];
}

export class FakeBridge implements PatientBridge {
  readonly enqueued: FakeEnqueue[] = [];
  readonly revisions: Array<{ draftId: string; input: ReviseAgentDraftInput }> = [];
  readonly revisionRequests: Array<{ draftId: string; instruction: string }> = [];
  readonly notices: string[] = [];
  readonly active = new Map<string, Draft>();
  readonly drafts = new Map<string, Draft>();
  readonly verifiedBodies = new Map<string, string[]>();
  private seq = 0;

  seedDraft(draft: Partial<Draft> & { id: string; version?: number }): Draft {
    const value = {
      status: 'PUSHED',
      advisorId: 'adv_1',
      groupRoomId: 'wr_g1',
      customerId: 'wm_patient',
      version: 1,
      body: '第一版正文',
      inboundSummary: '客户问题',
      ...draft,
    } as Draft;
    this.drafts.set(value.id, value);
    this.active.set(value.advisorId, value);
    return value;
  }

  async enqueueDraft(input: FakeEnqueue): Promise<{ draftId: string; version: number }> {
    this.enqueued.push(input);
    const draftId = `draft_${++this.seq}`;
    const draft = {
      id: draftId,
      advisorId: input.advisorId,
      groupRoomId: input.groupRoomId,
      customerId: input.customerId,
      version: 1,
      body: input.body,
      status: 'PUSHED',
    } as Draft;
    this.drafts.set(draftId, draft);
    return { draftId, version: 1 };
  }

  async reviseDraft(
    draftId: string,
    input: ReviseAgentDraftInput,
  ): Promise<{ draftId: string; version: number }> {
    this.revisions.push({ draftId, input });
    const draft = this.drafts.get(draftId);
    const version = (draft?.version ?? 1) + 1;
    if (draft) {
      draft.version = version;
      draft.body = input.body;
      draft.status = 'PUSHED';
    }
    return { draftId, version };
  }

  requestRevision(draftId: string, instruction: string): void {
    this.revisionRequests.push({ draftId, instruction });
  }

  getActiveDraft(advisorId: string): Draft | undefined {
    return this.active.get(advisorId);
  }

  getDraft(draftId: string): Draft | undefined {
    return this.drafts.get(draftId);
  }

  listVerifiedBodies(senderId: string): string[] {
    return this.verifiedBodies.get(senderId) ?? [];
  }

  async notifyAdvisor(text: string): Promise<void> {
    this.notices.push(text);
  }

  bindGroup(): void {}
}

export function setupRuntime(
  options: {
    requireConsentForTurn?: boolean;
    guard?: DraftGuardPort;
    memory?: PatientMemoryPort;
    capabilities?: () => AgentCapabilities;
    maxProactivePerHour?: number;
    schedule?: (fn: () => void, delayMs: number) => unknown;
    cancelSchedule?: (handle: unknown) => void;
  } = {},
) {
  const base = setupPatient(options);
  const sessions = new FakeSessions();
  const bridge = new FakeBridge();
  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const runtime = new PatientAgentRuntime({
    service: base.service,
    settings: SETTINGS,
    bridge,
    guard: options.guard,
    sessions,
    emit: (type, data) => events.push({ type, data }),
    logger: (line) => logs.push(line),
    mergeWindowMs: 30_000,
    mergeMaxWaitMs: 120_000,
    now: () => base.clock.now(),
    schedule: options.schedule ?? (() => 1),
    cancelSchedule: options.cancelSchedule ?? (() => undefined),
    memory: options.memory,
    capabilities: options.capabilities,
    maxProactivePerHour: options.maxProactivePerHour,
  });
  return { ...base, sessions, bridge, runtime, events, logs };
}

export function observeServiceGroup(
  harness: ReturnType<typeof setupPatient>,
  options: {
    roomId?: string;
    advisorId?: string;
    externalIds?: string[];
    staffIds?: string[];
    status?: 'serving' | 'collect_only' | 'pending' | 'disabled';
  } = {},
) {
  const roomId = options.roomId ?? 'wr_g1';
  const externalIds = options.externalIds ?? ['wm_patient'];
  const staffIds = options.staffIds ?? ['wang.guwen'];
  const group = harness.service.observeGroup(
    roomId,
    [
      ...externalIds.map((id, index) => ({
        id,
        isExternal: true,
        displayName: `外部成员${index}`,
        lastActiveAt: harness.clock.now(),
      })),
      ...staffIds.map((id) => ({
        id,
        isExternal: false,
        lastActiveAt: harness.clock.now(),
      })),
    ],
    { groupName: '减重-张女士', groupNameSource: 'config' },
  );
  if (options.advisorId) harness.service.setGroupAdvisor(group.id, options.advisorId);
  if (options.status) harness.service.setGroupStatus(group.id, options.status);
  return group;
}

/** 与 C2 真实服务对接的桥，给 #56 的端到端单测用 */
export function c2Bridge(service: import('../src/c2/service.ts').C2Service): PatientBridge {
  const bridge: PatientBridge = {
    async enqueueDraft(input) {
      const draft = service.enqueueDraft({
        advisorId: input.advisorId,
        groupRoomId: input.groupRoomId,
        customerId: input.customerId,
        customerName: input.customerName,
        lastInboundAt: input.lastInboundAt,
        inboundMessageId: input.inboundMessageIds[0] ?? `merged_${Date.now()}`,
        inboundMessageIds: input.inboundMessageIds,
        mediaIds: input.mediaIds,
        mediaKinds: input.mediaKinds,
        inboundSummary: input.inboundSummary,
        body: input.body,
        riskLevel: input.riskLevel,
        ruleIds: input.ruleIds,
        ruleNames: input.ruleNames,
        source: input.source,
        fallback: input.fallback,
        citedMemoryIds: input.citedMemoryIds,
        citedKnowledgeIds: input.citedKnowledgeIds,
      });
      return { draftId: draft.id, version: draft.version ?? 1 };
    },
    async reviseDraft(draftId, input) {
      const draft = service.reviseDraft(draftId, input);
      return { draftId: draft.id, version: draft.version ?? 1 };
    },
    requestRevision(draftId, instruction) {
      service.requestRevision(draftId, instruction);
    },
    getActiveDraft(advisorId) {
      const id = service.store.getActiveDraft(advisorId);
      return id ? service.store.getDraft(id) : undefined;
    },
    getDraft(draftId) {
      return service.store.getDraft(draftId);
    },
    listVerifiedBodies(senderId) {
      return service.store
        .listDrafts()
        .filter(
          (draft) =>
            draft.customerId === senderId &&
            (draft.status === 'VERIFIED' || draft.status === 'EDIT_SENT'),
        )
        .map((draft) => draft.body);
    },
    async notifyAdvisor(text) {
      await service.bot.sendText('chat_adv_1', text);
    },
  };
  return bridge;
}

export type { VerifyOutcome, CustomerGroup, PatientSnapshot };
