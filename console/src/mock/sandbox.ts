/**
 * 体验沙盒 mock。按 docs/P1-api.md §12：
 * 真 DSH / 真模型在真实环境执行；前端 mock 只模拟渠道与结果，
 * 让四种核验结果、记忆面板与上传图片都能在本地走通。
 */
import { API_BASE, ApiError, isMockMode } from './http.ts';
import { mediaUrl, uploadSandboxImage, type UploadedMedia } from './media.ts';

export type SandboxDraftStatus =
  | 'QUEUED'
  | 'PUSHED'
  | 'ACKNOWLEDGED'
  | 'VERIFIED'
  | 'EDIT_SENT'
  | 'MISROUTE_ALERT'
  | 'UNVERIFIED';

export type SandboxAction =
  | 'send_original'
  | 'send_edited'
  | 'send_wrong_group'
  | 'ack_only';

export type VerificationOutcome = 'verified' | 'edit_sent' | 'misroute' | 'unverified';

export interface SandboxGroup {
  id: string;
  name: string;
  role: 'primary' | 'other';
}

export interface SandboxSession {
  id: string;
  patient: { id: string; displayName: string; demo: boolean };
  groups: SandboxGroup[];
  createdAt: number;
  lastActiveAt: number;
}

export interface SandboxPreset {
  id: string;
  label: string;
  kind: 'text' | 'image';
  text?: string;
  mediaId?: string;
}

export interface SandboxGuideStep {
  step: number;
  title: string;
  hint: string;
}

export interface SandboxQuota {
  dailyLimit: number;
  usedToday: number;
  remaining: number;
}

export interface SandboxMessage {
  id: string;
  at: number;
  sender: 'customer';
  kind: 'text' | 'image';
  text?: string;
  mediaId?: string;
  imageUrl?: string;
}

export interface SandboxMemory {
  id: string;
  category: 'dietary_taboo' | 'goal' | 'preference' | 'routine';
  content: string;
  createdAt: number;
}

export interface SandboxRevision {
  version: number;
  body: string;
  instruction: string | null;
  createdBy: 'agent' | 'staff';
  createdAt: number;
}

export interface SandboxDraft {
  id: string;
  version: number;
  body: string;
  status: SandboxDraftStatus;
  createdAt: number;
  revisions: SandboxRevision[];
}

export interface SandboxVerification {
  id: string;
  outcome: VerificationOutcome;
  matchedMsgId: string | null;
  matchedRoomId: string | null;
  matchedGroupName: string | null;
  similarity: number | null;
  attempts: number;
  checkedAt: number;
  sandbox: true;
}

export interface SandboxEvent {
  id: string;
  type: string;
  at: number;
  data: Record<string, unknown>;
}

export interface SandboxState {
  session: SandboxSession;
  messages: SandboxMessage[];
  memories: SandboxMemory[];
  drafts: SandboxDraft[];
  verification: SandboxVerification | null;
  events: SandboxEvent[];
  quota: SandboxQuota;
}

export interface SandboxSessionResponse {
  session: SandboxSession;
  presets: SandboxPreset[];
  guideSteps: SandboxGuideStep[];
  quota: SandboxQuota;
}

export interface SandboxActionResult {
  outcome: VerificationOutcome;
  draftStatus: SandboxDraftStatus;
  verification: SandboxVerification;
}

const STORAGE_KEY = 'zhiban.console.j.sandbox';
const DAILY_LIMIT = 100;

const uploadedMedia = new Map<string, string>();
const listeners = new Set<() => void>();
let realSource: EventSource | null = null;

export const SANDBOX_PRESETS: SandboxPreset[] = [
  { id: 'preset_allergy', label: '我对海鲜过敏', kind: 'text', text: '我对海鲜过敏' },
  { id: 'preset_dinner', label: '晚上吃什么好', kind: 'text', text: '晚上吃什么好' },
  {
    id: 'preset_meal_photo',
    label: '发一张餐食照片',
    kind: 'image',
    mediaId: 'med_sample_meal_01',
  },
];

export const SANDBOX_GUIDE_STEPS: SandboxGuideStep[] = [
  { step: 1, title: '告诉 Agent 一件重要的事', hint: '点击「我对海鲜过敏」' },
  { step: 2, title: '看记忆面板', hint: '右侧出现一条饮食禁忌记忆' },
  { step: 3, title: '问一个相关问题', hint: '点击「晚上吃什么好」，草稿会避开海鲜' },
  {
    step: 4,
    title: '试试四种发送方式',
    hint: '照发 / 改写后发 / 发到别的群 / 只点已发送',
  },
];

export const SANDBOX_PRESET_IMAGES: { mediaId: string; label: string }[] = [
  { mediaId: 'med_sample_meal_01', label: '清蒸鱼套餐' },
  { mediaId: 'med_sample_meal_02', label: '牛肉面' },
  { mediaId: 'med_sample_meal_03', label: '小米粥' },
];

function seedState(): SandboxState {
  const now = Date.now();
  return {
    session: {
      id: `sbx_${now}`,
      patient: { id: 'pat_sandbox_acc_01', displayName: '体验患者', demo: false },
      groups: [
        { id: 'grp_sandbox_1', name: '体验客户群', role: 'primary' },
        { id: 'grp_sandbox_2', name: '另一个客户群', role: 'other' },
      ],
      createdAt: now,
      lastActiveAt: now,
    },
    messages: [],
    memories: [],
    drafts: [],
    verification: null,
    events: [],
    quota: { dailyLimit: DAILY_LIMIT, usedToday: 0, remaining: DAILY_LIMIT },
  };
}

function readState(): SandboxState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SandboxState) : null;
  } catch {
    return null;
  }
}

function writeState(state: SandboxState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式下仅当前会话生效
  }
  notify();
}

function ensureState(): SandboxState {
  const stored = readState();
  if (stored) return stored;
  const next = seedState();
  writeState(next);
  return next;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 仅供测试 */
export function resetSandboxMock(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  uploadedMedia.clear();
  notify();
}

export function subscribeSandbox(listener: () => void): () => void {
  if (!isMockMode) {
    listeners.add(listener);
    if (!realSource) {
      realSource = new EventSource(`${API_BASE}/sse/events?types=sandbox.*`, {
        withCredentials: true,
      });
      realSource.onmessage = () => notify();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && realSource) {
        realSource.close();
        realSource = null;
      }
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function createSandboxSession(): Promise<SandboxSessionResponse> {
  if (!isMockMode) {
    return apiRequest<SandboxSessionResponse>('/sandbox/session', { method: 'POST' });
  }
  const state = ensureState();
  return {
    session: state.session,
    presets: SANDBOX_PRESETS,
    guideSteps: SANDBOX_GUIDE_STEPS,
    quota: state.quota,
  };
}

export async function getSandboxState(since?: number): Promise<SandboxState> {
  if (!isMockMode) {
    return apiRequest<SandboxState>(
      `/sandbox/state${typeof since === 'number' ? `?since=${since}` : ''}`,
    );
  }
  const state = ensureState();
  if (typeof since !== 'number') return state;
  return {
    ...state,
    events: state.events.filter((event) => event.at > since),
    messages: state.messages.filter((message) => message.at > since),
  };
}

export async function resetSandboxSession(): Promise<SandboxSessionResponse> {
  if (!isMockMode) {
    return apiRequest<SandboxSessionResponse>('/sandbox/session/reset', { method: 'POST' });
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  const next = seedState();
  writeState(next);
  return {
    session: next.session,
    presets: SANDBOX_PRESETS,
    guideSteps: SANDBOX_GUIDE_STEPS,
    quota: next.quota,
  };
}

export interface SendSandboxMessageInput {
  kind: 'text' | 'image';
  text?: string;
  mediaId?: string;
}

export interface SendSandboxResult {
  messageId: string;
  acceptedAt: number;
  quota: SandboxQuota;
}

export async function sendSandboxMessage(
  input: SendSandboxMessageInput,
): Promise<SendSandboxResult> {
  if (!isMockMode) {
    return apiRequest<SendSandboxResult>('/sandbox/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  const state = ensureState();
  if (state.quota.remaining <= 0) {
    throw new ApiError('LIMIT_EXCEEDED', '今日沙盒次数已用完，请明天再试', 429);
  }

  const now = Date.now();
  const messageId = `msg_sbx_${now}`;
  const text = input.kind === 'text' ? (input.text ?? '').trim() : undefined;
  if (input.kind === 'text' && !text) {
    throw new ApiError('VALIDATION_FAILED', '消息内容不能为空', 422);
  }
  if (input.kind === 'image' && !input.mediaId) {
    throw new ApiError('VALIDATION_FAILED', '请选择一张图片', 422);
  }

  const message: SandboxMessage = {
    id: messageId,
    at: now,
    sender: 'customer',
    kind: input.kind,
    text,
    mediaId: input.mediaId,
    imageUrl:
      input.kind === 'image' && input.mediaId
        ? (uploadedMedia.get(input.mediaId) ?? mediaUrl(input.mediaId, 'meal'))
        : undefined,
  };
  state.messages.push(message);
  state.events.push({
    id: `evt_${now}_msg`,
    type: 'sandbox.message',
    at: now,
    data: { sessionId: state.session.id, messageId },
  });
  state.quota = {
    ...state.quota,
    usedToday: state.quota.usedToday + 1,
    remaining: Math.max(0, state.quota.remaining - 1),
  };

  const agentDraft = buildAgentDraft(state, input, now);
  if (agentDraft) {
    state.drafts.push(agentDraft);
    state.events.push({
      id: `evt_${now}_draft`,
      type: 'sandbox.draft',
      at: now,
      data: { sessionId: state.session.id, draftId: agentDraft.id },
    });
  }

  state.session = { ...state.session, lastActiveAt: now };
  state.verification = null;
  writeState(state);
  return { messageId, acceptedAt: now, quota: state.quota };
}

function buildAgentDraft(
  state: SandboxState,
  input: SendSandboxMessageInput,
  now: number,
): SandboxDraft | null {
  const text = input.text ?? '';

  if (input.kind === 'text' && /海鲜|过敏/.test(text)) {
    const content = '对海鲜过敏';
    const existing = state.memories.find((item) => item.content === content);
    if (!existing) {
      state.memories.push({
        id: `mem_sbx_${now}`,
        category: 'dietary_taboo',
        content,
        createdAt: now,
      });
      state.events.push({
        id: `evt_${now}_memory`,
        type: 'sandbox.memory',
        at: now,
        data: { sessionId: state.session.id, content },
      });
    }
    return null;
  }

  let body: string;
  if (input.kind === 'text' && /晚上|吃什么/.test(text)) {
    const hasAllergy = state.memories.some((item) => /海鲜/.test(item.content));
    body = hasAllergy
      ? '晚上建议清淡一点，主食选糙米或杂粮，搭配一份鱼或豆腐，再来两拳头的绿叶菜。记得避开海鲜（来自您的饮食禁忌记忆）。'
      : '晚上建议清淡一点，主食选糙米或杂粮，搭配一份鱼或豆腐，再来两拳头的绿叶菜。';
  } else if (input.kind === 'image') {
    body =
      '看到这张餐食照片了，整体搭配不错。主食控制在小半碗，蔬菜量也够，鱼的做法清淡一些，继续保持。';
  } else {
    body = '收到，我先记下来，稍后结合您的健康记录给建议。';
  }

  return {
    id: `draft_sbx_${now}`,
    version: 1,
    body,
    status: 'PUSHED',
    createdAt: now,
    revisions: [
      {
        version: 1,
        body,
        instruction: null,
        createdBy: 'agent',
        createdAt: now,
      },
    ],
  };
}

export interface SandboxActionOptions {
  editedBody?: string;
  targetGroupId?: string;
}

export async function applySandboxAction(
  draftId: string,
  action: SandboxAction,
  options: SandboxActionOptions = {},
): Promise<SandboxActionResult> {
  if (!isMockMode) {
    return apiRequest<SandboxActionResult>(`/sandbox/drafts/${draftId}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...(options.editedBody ? { editedBody: options.editedBody } : {}),
        ...(options.targetGroupId ? { targetGroupId: options.targetGroupId } : {}),
      }),
    });
  }

  const state = ensureState();
  const draft = state.drafts.find((item) => item.id === draftId);
  if (!draft) throw new ApiError('NOT_FOUND', '草稿不属于当前沙盒', 404);
  if (['VERIFIED', 'EDIT_SENT', 'MISROUTE_ALERT', 'UNVERIFIED'].includes(draft.status)) {
    throw new ApiError('CONFLICT', '该草稿已产生核验结果', 409);
  }

  const now = Date.now();
  const primary = state.session.groups.find((group) => group.role === 'primary');
  const wrong = options.targetGroupId
    ? state.session.groups.find((group) => group.id === options.targetGroupId)
    : state.session.groups.find((group) => group.id !== primary?.id);
  const targetGroup = action === 'send_wrong_group' ? wrong : primary;
  if (action === 'send_wrong_group' && !targetGroup) {
    throw new ApiError('VALIDATION_FAILED', '请选择要发错的群', 422);
  }

  const outcome = outcomeOf(action);
  if (action === 'send_edited') {
    const edited = (options.editedBody ?? '').trim();
    if (!edited) throw new ApiError('VALIDATION_FAILED', '改写内容不能为空', 422);
    draft.body = edited;
    draft.version += 1;
    draft.revisions.push({
      version: draft.version,
      body: edited,
      instruction: '沙盒改写',
      createdBy: 'staff',
      createdAt: now,
    });
  }

  draft.status = statusOf(outcome);
  const verification: SandboxVerification = {
    id: `vrf_sbx_${now}`,
    outcome,
    matchedMsgId: action === 'ack_only' ? null : `msg_sbx_sent_${now}`,
    matchedRoomId: action === 'ack_only' ? null : (targetGroup?.id ?? null),
    matchedGroupName: action === 'ack_only' ? null : (targetGroup?.name ?? null),
    similarity: outcome === 'edit_sent' ? 0.82 : outcome === 'verified' ? 1 : 0.99,
    attempts: 1,
    checkedAt: now,
    sandbox: true,
  };
  state.verification = verification;
  state.events.push({
    id: `evt_${now}_verify`,
    type: 'sandbox.verification',
    at: now,
    data: { sessionId: state.session.id, outcome, draftId },
  });
  state.session = { ...state.session, lastActiveAt: now };
  writeState(state);

  return { outcome, draftStatus: draft.status, verification };
}

function outcomeOf(action: SandboxAction): VerificationOutcome {
  if (action === 'send_original') return 'verified';
  if (action === 'send_edited') return 'edit_sent';
  if (action === 'send_wrong_group') return 'misroute';
  return 'unverified';
}

function statusOf(outcome: VerificationOutcome): SandboxDraftStatus {
  if (outcome === 'verified') return 'VERIFIED';
  if (outcome === 'edit_sent') return 'EDIT_SENT';
  if (outcome === 'misroute') return 'MISROUTE_ALERT';
  return 'UNVERIFIED';
}

export async function uploadSandboxFile(file: File): Promise<UploadedMedia> {
  const uploaded = await uploadSandboxImage(file);
  if (isMockMode) uploadedMedia.set(uploaded.mediaId, uploaded.url);
  return uploaded;
}

export const SANDBOX_OUTCOME_LABELS: Record<
  VerificationOutcome,
  { label: string; color: string }
> = {
  verified: { label: '✅ 已核验', color: 'green' },
  edit_sent: { label: '✏️ 改后发送', color: 'purple' },
  misroute: { label: '⚠️ 发错群', color: 'red' },
  unverified: { label: '❌ 未核验', color: 'volcano' },
};

export const SANDBOX_ACTION_LABELS: Record<SandboxAction, string> = {
  send_original: '照发',
  send_edited: '改写后发',
  send_wrong_group: '发到别的群',
  ack_only: '只点已发送',
};

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new ApiError(
      error?.code || 'INTERNAL',
      error?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return payload as T;
}
