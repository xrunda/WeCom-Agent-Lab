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
  /** 本地日期 YYYY-MM-DD（判断能否提前完成用） */
  scheduledDate?: string;
  status: ItemStatus;
  feedbackKind: 'checkin' | 'record_meal' | 'record_review';
  overdue: boolean;
  cancelReason?: string | null;
  /** 今天及以前、未取消、未完成时才可反馈（未来事项不可提前完成） */
  canFeedback?: boolean;
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

export async function submitItemFeedback(input: {
  itemId: string;
  kind: 'patient_confirmed' | 'missed' | 'needs_help';
  reason?: string;
}): Promise<CalendarItemView> {
  if (isDemoMode()) {
    const { demoFeedback } = await import('./mock/demo-api.ts');
    return demoFeedback(input);
  }
  return apiRequest<CalendarItemView>(`/calendar/items/${input.itemId}/feedback`, {
    method: 'POST',
    body: { kind: input.kind, ...(input.reason ? { reason: input.reason } : {}) },
  });
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
  actions: Array<{
    actionId: string;
    title: string;
    purpose: string;
    method: string;
    schedule: { kind: string; time: string };
    feedbackKind: string;
    linkedArticleIds: string[];
  }>;
  feedbackRequirements: string[];
  review: { reviewerName: string; reviewedAt: number };
  publishedAt: number;
  acknowledgedAt: number | null;
}

export async function submitPlanAdjust(input: {
  planVersion: number;
  message: string;
}): Promise<{ id: string; status: string }> {
  if (isDemoMode()) {
    return Promise.resolve({ id: `fup_demo_${Date.now()}`, status: 'pending' });
  }
  return apiRequest<{ id: string; status: string }>('/plan/adjust-requests', {
    method: 'POST',
    body: input,
  });
}

export async function acknowledgePlan(): Promise<{ acknowledgedAt: number }> {
  if (isDemoMode()) return Promise.resolve({ acknowledgedAt: Date.now() });
  return apiRequest<{ acknowledgedAt: number }>('/plan/acknowledge', { method: 'POST', body: {} });
}

export async function fetchCurrentPlan(): Promise<PlanView> {
  if (isDemoMode()) {
    const { demoPlan } = await import('./mock/demo-api.ts');
    return demoPlan();
  }
  // 契约 api §5.1 响应为 { plan: {...} }，这里解包成视图
  const body = await apiRequest<{ plan: PlanView }>('/plan/current');
  return body.plan;
}

// ---------- 记录（H06 / H07，契约 api §7） ----------

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface FoodCandidate {
  name: string;
  confidence: number;
}

export interface RecordView {
  id: string;
  kind: 'meal' | 'evening_review' | 'note';
  occurredAt: number;
  occurredDate: string;
  submittedAt: number;
  content: Record<string, unknown>;
  recognition?: { status: string; candidates: FoodCandidate[] };
  mediaIds: string[];
  duplication?: { status: string; suspectedIds: string[] };
}

export async function createMealRecord(input: {
  occurredAt: number;
  mealType: MealType;
  confirmedFoods?: Array<{ name: string; portion?: string }>;
  patientNotes?: string;
  linkedCalendarItemId?: string;
  idempotencyKey?: string;
}): Promise<RecordView> {
  if (isDemoMode()) {
    const { demoCreateRecord } = await import('./mock/demo-api.ts');
    return demoCreateRecord({
      kind: 'meal',
      occurredAt: input.occurredAt,
      meal: {
        mealType: input.mealType,
        confirmedFoods: input.confirmedFoods ?? [],
        ...(input.patientNotes ? { patientNotes: input.patientNotes } : {}),
      },
    });
  }
  return apiRequest<RecordView>('/records', {
    method: 'POST',
    body: {
      kind: 'meal',
      occurredAt: input.occurredAt,
      meal: {
        mealType: input.mealType,
        confirmedFoods: input.confirmedFoods ?? [],
        ...(input.patientNotes ? { patientNotes: input.patientNotes } : {}),
      },
      ...(input.linkedCalendarItemId
        ? { linkedCalendarItemIds: [input.linkedCalendarItemId] }
        : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  });
}

export async function createEveningReview(input: {
  occurredAt: number;
  overall?: string;
  mood?: string;
  sleep?: string;
  bowel?: string;
  discomfort?: string;
  notes?: string;
  idempotencyKey?: string;
}): Promise<RecordView> {
  if (isDemoMode()) {
    const { demoCreateRecord } = await import('./mock/demo-api.ts');
    return demoCreateRecord({
      kind: 'evening_review',
      occurredAt: input.occurredAt,
      review: {
        ...(input.overall ? { overall: input.overall } : {}),
        ...(input.mood ? { mood: input.mood } : {}),
        ...(input.sleep ? { sleep: input.sleep } : {}),
        ...(input.bowel ? { bowel: input.bowel } : {}),
        ...(input.discomfort ? { discomfort: input.discomfort } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      },
    });
  }
  const { occurredAt, idempotencyKey, ...review } = input;
  return apiRequest<RecordView>('/records', {
    method: 'POST',
    body: {
      kind: 'evening_review',
      occurredAt,
      review,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  });
}

export async function uploadRecordPhoto(input: {
  recordId: string;
  file: Blob;
}): Promise<{ mediaId: string; recognition: { status: string; candidates: FoodCandidate[] } }> {
  if (isDemoMode()) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      mediaId: 'med_demo',
      recognition: { status: 'skipped', candidates: [] },
    };
  }
  const form = new FormData();
  form.append('photo', input.file, 'photo.jpg');
  const response = await fetch(`/zhiban/h5/records/${input.recordId}/photo`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(response.status, body?.error ?? { code: 'INTERNAL', message: '上传失败' });
  }
  return (await response.json()) as { mediaId: string; recognition: { status: string; candidates: FoodCandidate[] } };
}

export async function confirmRecordFoods(
  recordId: string,
  confirmedFoods: Array<{ name: string; portion?: string }>,
): Promise<RecordView> {
  if (isDemoMode()) {
    return { id: recordId, kind: 'meal', occurredAt: Date.now(), occurredDate: '', submittedAt: Date.now(), content: {}, mediaIds: [] };
  }
  return apiRequest<RecordView>(`/records/${recordId}/confirm`, {
    method: 'POST',
    body: { confirmedFoods },
  });
}

// ---------- 专业团队（H10，契约 api §8） ----------

export interface TeamInfo {
  advisorName: string;
  members: Array<{ name: string; role: string }>;
  serviceHours: string;
  categories: Array<{ key: string; label: string }>;
}

export interface FollowupView {
  id: string;
  kind: string;
  message: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending' | 'claimed' | 'resolved';
  assigneeName: string | null;
  claimedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  overdue: boolean;
}

export async function fetchTeam(): Promise<TeamInfo> {
  if (isDemoMode()) {
    return {
      advisorName: '李顾问（虚构）',
      members: [{ name: '陈营养师（虚构）', role: '专业审核' }],
      serviceHours: '工作日 09:00–18:00',
      categories: [
        { key: 'plan', label: '计划问题' },
        { key: 'record', label: '记录问题' },
        { key: 'body', label: '身体感受' },
        { key: 'other', label: '其他' },
      ],
    };
  }
  return apiRequest<TeamInfo>('/team');
}

export async function submitTeamRequest(input: {
  category: string;
  message: string;
  linkedPlanId?: string;
}): Promise<{ id: string; status: string; acknowledged: boolean }> {
  if (isDemoMode()) {
    const { demoCreateFollowup } = await import('./mock/demo-api.ts');
    return demoCreateFollowup(input);
  }
  return apiRequest<{ id: string; status: string; acknowledged: boolean }>('/team/requests', {
    method: 'POST',
    body: input,
  });
}

export async function fetchTeamRequests(): Promise<{ items: FollowupView[] }> {
  if (isDemoMode()) {
    const { demoFollowups } = await import('./mock/demo-api.ts');
    return { items: demoFollowups() };
  }
  return apiRequest<{ items: FollowupView[] }>('/team/requests');
}

// ---------- 个人中心（H09，契约 api §4.1 / §7.5 / §10） ----------

export interface ProfileCenterStats {
  companionDays: number;
  mealRecords: number;
  reviewDays: number;
  basis: { startedAt: number | null; mealWindowDays: number };
}

export async function fetchMeStats(): Promise<ProfileCenterStats> {
  if (isDemoMode()) {
    const { demoStats } = await import('./mock/demo-api.ts');
    return demoStats();
  }
  return apiRequest<ProfileCenterStats>('/me/stats');
}

export interface RecordHistoryItem {
  id: string;
  kind: 'meal' | 'evening_review' | 'note';
  occurredAt: number;
  occurredDate: string;
  content: Record<string, unknown>;
}

export async function fetchRecordHistory(date?: string): Promise<{ items: RecordHistoryItem[] }> {
  if (isDemoMode()) {
    const { demoHistory } = await import('./mock/demo-api.ts');
    return { items: demoHistory(date) };
  }
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return apiRequest<{ items: RecordHistoryItem[] }>(`/records/history${query}`);
}

export async function requestProfileCorrection(input: {
  entryId: string;
  detail: string;
}): Promise<{ followupId: string }> {
  if (isDemoMode()) return { followupId: 'fup_demo_correction' };
  return apiRequest<{ followupId: string }>('/profile/corrections', {
    method: 'POST',
    body: input,
  });
}

export interface ReminderPrefs {
  enabled: boolean;
  dailyLimit?: number;
  quietHours?: { start: string; end: string };
  gentleInquiry?: boolean;
  tenantDefaults: { dailyLimit: number; quietHours: { start: string; end: string } };
}

export async function fetchReminderPrefs(): Promise<ReminderPrefs> {
  if (isDemoMode()) {
    const { demoPrefs } = await import('./mock/demo-api.ts');
    return demoPrefs();
  }
  return apiRequest<ReminderPrefs>('/reminder-prefs');
}

export async function updateReminderPrefs(
  patch: Partial<Pick<ReminderPrefs, 'enabled' | 'dailyLimit' | 'quietHours' | 'gentleInquiry'>>,
): Promise<ReminderPrefs> {
  if (isDemoMode()) {
    const { demoUpdatePrefs } = await import('./mock/demo-api.ts');
    return demoUpdatePrefs(patch);
  }
  return apiRequest<ReminderPrefs>('/reminder-prefs', { method: 'PATCH', body: patch });
}
