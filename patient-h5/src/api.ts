/**
 * 患者端 H5 API 客户端（PH5-02 #231，契约 docs/PATIENT-H5-api.md）。
 *
 * - 同源 Cookie 会话（zb_h5_session），不操作、不读取其他 Cookie
 * - 写请求带 Idempotency-Key（隐私申请等）
 * - 401 统一触发 onUnauthorized 回调（App 切回登录态）
 * - 邀请 code 只存在内存 state；不写 localStorage、不进任何日志
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Array<{ field?: string; issue?: string }>;
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Array<{ field?: string; issue?: string }>;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

export function newIdempotencyKey(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `h5_${random}`;
}

/**
 * 演示模式：VITE_API_MODE=demo 时用本地虚构数据（视觉走查/路演）。
 * 真实接口照常走 fetch；测试环境变量为空，始终走 fetch。
 */
export const isDemoMode = (): boolean =>
  (import.meta.env as Record<string, string | undefined>).VITE_API_MODE === 'demo';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  body?: unknown;
  idempotencyKey?: string;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`/zhiban/h5${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, body ?? { code: 'INTERNAL', message: '服务暂时不可用' });
  }
  return payload as T;
}

// ---------- 会话与登录 ----------

export interface VerifyCodeResponse {
  phoneTail: string;
  expiresIn: number;
}

export function requestVerifyCode(input: { invitationCode?: string; phone?: string }): Promise<VerifyCodeResponse> {
  return apiRequest<VerifyCodeResponse>('/auth/verify-code', { method: 'POST', body: input });
}

export interface RedeemResponse {
  session: { patientId: string; issuedAt: number; expiresAt: number };
  binding: { phoneTail: string; boundAt: number };
  me: { status: string };
}

export function redeemInvitation(input: {
  invitationCode: string;
  phone: string;
  code: string;
}): Promise<RedeemResponse> {
  return apiRequest<RedeemResponse>('/auth/redeem', { method: 'POST', body: input });
}

export function loginWithPhone(input: { phone: string; code: string }): Promise<RedeemResponse> {
  return apiRequest<RedeemResponse>('/auth/login', { method: 'POST', body: input });
}

export function logout(): Promise<void> {
  return apiRequest<void>('/auth/logout', { method: 'POST', body: {} });
}

export interface MeResponse {
  status: string;
  reminderEnabled: boolean;
  serverTime: number;
  /** 陪伴天数（契约 api §4.1）；PH5-10 前真实接口为 null */
  companionDays?: number | null;
  profile?: { completeness: number; safetyMissing: boolean; conflicts: unknown[] };
  plan?: { planId: string; version: number; status: string; endDate: string } | null;
}

export async function fetchMe(): Promise<MeResponse> {
  if (isDemoMode()) {
    const { demoMe } = await import('./mock/demo-api.ts');
    return demoMe();
  }
  return apiRequest<MeResponse>('/me');
}

// ---------- 授权 ----------

export interface ConsentItem {
  scope: string;
  status: 'granted' | 'withdrawn' | 'never';
  version: number;
  grantedAt: number | null;
  withdrawnAt: number | null;
  title: string;
  summary: string;
}

export interface ConsentsResponse {
  textsVersion: number;
  items: ConsentItem[];
}

export function fetchConsents(): Promise<ConsentsResponse> {
  return apiRequest<ConsentsResponse>('/consents');
}

export function decideConsent(input: {
  scope: string;
  action: 'grant' | 'withdraw';
}): Promise<{ scope: string; status: string; version: number }> {
  return apiRequest('/consents/decide', { method: 'POST', body: input });
}

// ---------- 隐私 ----------

export interface PrivacySummary {
  retentionNotice: string;
  /** 已授权给团队的 scope（契约 api §3.3） */
  teamAccessScopes: string[];
  requests: Array<{
    id: string;
    kind: 'export' | 'correction' | 'deletion';
    status: 'submitted' | 'handled' | 'rejected';
    createdAt: number;
  }>;
}

export function fetchPrivacySummary(): Promise<PrivacySummary> {
  return apiRequest<PrivacySummary>('/privacy/summary');
}

export function createPrivacyRequest(input: {
  kind: 'export' | 'correction' | 'deletion';
  detail: string;
  idempotencyKey: string;
}): Promise<unknown> {
  return apiRequest('/privacy/requests', { method: 'POST', body: input, idempotencyKey: input.idempotencyKey });
}

// ---------- 埋点 ----------

export function reportEvent(
  event: string,
  options: { itemId?: string; durationMs?: number } = {},
): Promise<void> {
  return apiRequest('/events', { method: 'POST', body: { event, ...options } });
}

// ---------- 通用 ----------

export function fetchServerTime(): Promise<{ serverTime: number; timezone: string }> {
  return apiRequest<{ serverTime: number; timezone: string }>('/server-time');
}

// ---------- 食养主张（公开，H01） ----------

export interface ManifestoSection {
  kind: 'classic_quote' | 'plain_explanation' | 'brand_copy';
  text: string;
  citation?: string;
}

export interface Manifesto {
  version: number;
  slogans: string[];
  sections: ManifestoSection[];
}

export function fetchManifesto(): Promise<Manifesto> {
  return apiRequest<Manifesto>('/manifesto');
}

// ---------- 轻量建档（H02，契约 api §4） ----------

export type ProfileFieldKey =
  | 'goal'
  | 'meal_times'
  | 'sleep_time'
  | 'food_preference'
  | 'allergy'
  | 'existing_guidance';

export interface ProfileEntryView {
  id: string;
  fieldKey: ProfileFieldKey;
  value: Record<string, unknown>;
  valueText: string;
  source: 'patient' | 'advisor' | 'agent' | 'professional';
  status: 'draft' | 'confirmed' | 'disputed';
  updatedAt: number;
}

export interface ProfileStatusView {
  completeness: number;
  safetyMissing: boolean;
  conflicts: Array<{ fieldKey: ProfileFieldKey; detail: string }>;
}

export function fetchProfile(): Promise<{ items: ProfileEntryView[]; status: ProfileStatusView }> {
  return apiRequest<{ items: ProfileEntryView[]; status: ProfileStatusView }>('/profile');
}

export function submitProfileAnswers(input: {
  step: 'basics' | 'routine' | 'food' | 'safety' | 'guidance';
  answers: Partial<Record<ProfileFieldKey, Record<string, unknown>>>;
  /** 同一步骤重试时复用，服务端据此去重（契约 api §4.3） */
  idempotencyKey?: string;
}): Promise<{ entries: ProfileEntryView[]; status: ProfileStatusView }> {
  const { idempotencyKey, ...body } = input;
  return apiRequest<{ entries: ProfileEntryView[]; status: ProfileStatusView }>(
    '/profile/answers',
    { method: 'PUT', body, ...(idempotencyKey ? { idempotencyKey } : {}) },
  );
}

export function confirmProfileEntries(entryIds: string[]): Promise<unknown> {
  return apiRequest('/profile/confirm', { method: 'POST', body: { entryIds } });
}

// ---------- 今天与日历（H03 / H05，契约 api §6） ----------

export type ItemStatus = 'pending' | 'done' | 'missed' | 'needs_help' | 'cancelled';

export interface CalendarItemView {
  id: string;
  title: string;
  purpose: string;
  method?: string;
  scheduledAt: number;
  status: ItemStatus;
  feedbackKind: 'checkin' | 'record_meal' | 'record_review';
  overdue: boolean;
  cancelReason?: string | null;
}

export interface TodayView {
  date: string;
  greeting: string;
  nextItem: CalendarItemView | null;
  progress: { done: number; missed: number; needsHelp: number; pending: number; total: number };
  quickRecord: { meal: boolean; review: boolean };
  relatedArticles: ArticleView[];
  allDone: boolean;
  companionDays: number | null;
}

export interface DayView {
  date: string;
  items: CalendarItemView[];
}

export interface CalendarView {
  days: DayView[];
  from: number;
  to: number;
  dailyTip?: { title: string; text: string } | null;
}

export async function fetchToday(): Promise<TodayView> {
  if (isDemoMode()) {
    const { demoToday } = await import('./mock/demo-api.ts');
    return demoToday();
  }
  return apiRequest<TodayView>('/today');
}

export async function fetchCalendar(): Promise<CalendarView> {
  if (isDemoMode()) {
    const { demoCalendar } = await import('./mock/demo-api.ts');
    return demoCalendar();
  }
  return apiRequest<CalendarView>('/calendar');
}

// ---------- 内容（H05/H08 关联） ----------

export interface ArticleView {
  id: string;
  title: string;
  summary: string;
  category: 'classics_life' | 'ingredients' | 'seasonal_living';
  publishedAt: number;
}

export async function fetchArticles(): Promise<{ items: ArticleView[] }> {
  if (isDemoMode()) {
    const { demoArticles } = await import('./mock/demo-api.ts');
    return demoArticles();
  }
  return apiRequest<{ items: ArticleView[] }>('/articles');
}

// ---------- 计划（H04） ----------

export interface PlanView {
  id: string;
  version: number;
  status: string;
  stageGoal: string;
  startDate: string;
  endDate: string;
  foodTherapyRationale: string;
  focusPoints: string[];
  rationale: { basedOn: string[] };
  review: { reviewerName: string; reviewedAt: number };
  publishedAt: number;
  acknowledgedAt: number | null;
}

export async function fetchCurrentPlan(): Promise<PlanView> {
  if (isDemoMode()) {
    const { demoPlan } = await import('./mock/demo-api.ts');
    return demoPlan();
  }
  return apiRequest<PlanView>('/plan/current');
}
