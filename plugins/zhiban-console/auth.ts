/**
 * #41 账号、Cookie 会话与角色鉴权。
 *
 * - 密码 scrypt 强哈希，任何响应都不带哈希
 * - 会话 token 只存 SHA-256，Cookie HttpOnly / SameSite=Lax / 7 天
 * - 登录失败按 IP + 用户名限流；停用账号拒绝登录
 */
import {
  hashPassword,
  hashToken,
  LoginLimiter,
  newSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  validatePassword,
  verifyPassword,
} from '../../src/p1/console-auth.ts';
import { ConsoleError } from '../../src/p1/console-error.ts';
import type { ConsoleStore } from '../../src/p1/console-store.ts';
import {
  permissionsFor,
  type AccountRecord,
  type AccountStatus,
  type PublicAccount,
  type Role,
  type SessionRecord,
  type TenantRecord,
} from '../../src/p1/console-types.ts';
import type { HttpRequestLike } from './http.ts';
import { header, parseCookies } from './http.ts';
import { WECOM_SESSION_TTL_MS } from './config.ts';
import type { ConsoleConfig } from './config.ts';

export interface AuthActor {
  account: AccountRecord;
  tenant: TenantRecord | null;
  tokenHash: string;
}

export interface ConsoleAuthOptions {
  store: ConsoleStore;
  config: ConsoleConfig;
  now?: () => number;
  loginLimiter?: LoginLimiter;
  emit?: (type: string, data: unknown) => void;
}

/**
 * 患者端 H5 的职能能力（契约 PATIENT-H5-data-model §6.3）。
 *
 * 与角色权限矩阵分开：admin 也不自动拥有——专业审核是业务职责，
 * 不是管理权限。必须由管理员在账号上逐项显式授予。
 */
export const H5_CAPABILITIES = [
  'h5.plan.review',
  'h5.content.edit',
  'h5.content.review',
] as const;

export type H5Capability = (typeof H5_CAPABILITIES)[number];

/** 校验并归一 h5Permissions：只接受已知能力，去重排序；空数组表示全部收回 */
export function parseH5Permissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ConsoleError('VALIDATION_FAILED', 'h5Permissions 必须是数组', [
      { field: 'h5Permissions', issue: 'expected array' },
    ]);
  }
  const unknown = raw.filter(
    (item) => typeof item !== 'string' || !H5_CAPABILITIES.includes(item as H5Capability),
  );
  if (unknown.length > 0) {
    throw new ConsoleError('VALIDATION_FAILED', `不支持的能力：${unknown.join('、')}`, [
      { field: 'h5Permissions', issue: 'unknown capability' },
    ]);
  }
  return [...new Set(raw as string[])].sort();
}

export function publicAccount(account: AccountRecord): PublicAccount {
  const { passwordHash: _hash, ...rest } = account;
  return rest;
}

/** 审计里不出现完整企微 userid，只留尾号；失败登录也据此定位 */
function wecomActorName(userid: string): string {
  return userid.length <= 4 ? '企微成员***' : `企微成员***${userid.slice(-4)}`;
}

/** 企微 userid：1–64 位字母、数字与 `._@-`；空串视为「不绑定」 */
function parseWecomUserId(raw: unknown, field = 'wecomUserId'): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ConsoleError('VALIDATION_FAILED', '企微 userid 必须是字符串', [
      { field, issue: 'invalid wecomUserId' },
    ]);
  }
  const value = raw.trim();
  if (value === '') return undefined;
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(value)) {
    throw new ConsoleError('VALIDATION_FAILED', '企微 userid 只能是 1–64 位字母、数字或 ._@-', [
      { field, issue: 'invalid wecomUserId' },
    ]);
  }
  return value;
}

export function maskIp(ip: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.replace(/\.\d{1,3}$/, '.*');
  }
  return ip.includes(':') ? 'ipv6' : ip;
}

export class ConsoleAuthService {
  private readonly store: ConsoleStore;
  private readonly config: ConsoleConfig;
  private readonly now: () => number;
  readonly loginLimiter: LoginLimiter;
  private readonly emit: (type: string, data: unknown) => void;

  constructor(options: ConsoleAuthOptions) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? (() => Date.now());
    this.loginLimiter = options.loginLimiter ?? new LoginLimiter();
    this.emit = options.emit ?? (() => undefined);
  }

  /** 启动时补齐租户与部署配置里的账号；已存在的租户/账号不改写 */
  async initialize(): Promise<void> {
    const at = this.now();
    if (!this.store.getTenant(this.config.tenantId)) {
      this.store.saveTenant({
        id: this.config.tenantId,
        ...this.config.tenant,
        createdAt: at,
        updatedAt: at,
      });
    }

    await this.ensureSeedAccount(this.config.admin, 'admin', this.config.tenantId);
    if (this.config.platform) {
      await this.ensureSeedAccount(this.config.platform, 'platform', null);
    }
  }

  private async ensureSeedAccount(
    seed: { username: string; displayName: string; password: string },
    role: Role,
    tenantId: string | null,
  ): Promise<void> {
    if (this.store.findAccountByUsername(seed.username)) return;
    const at = this.now();
    const account: AccountRecord = {
      id: this.store.newId('acc'),
      tenantId,
      username: seed.username,
      displayName: seed.displayName,
      role,
      status: 'active',
      passwordHash: await hashPassword(seed.password),
      createdAt: at,
      updatedAt: at,
    };
    this.store.saveAccount(account);
  }

  get tenant(): TenantRecord {
    const tenant = this.store.getTenant(this.config.tenantId);
    if (!tenant) throw new ConsoleError('INTERNAL', '租户尚未初始化');
    return tenant;
  }

  async login(
    usernameRaw: unknown,
    password: unknown,
    ip: string,
  ): Promise<{ account: AccountRecord; tenant: TenantRecord | null; token: string; session: SessionRecord }> {
    if (typeof usernameRaw !== 'string' || usernameRaw.trim() === '') {
      throw new ConsoleError('INVALID_CREDENTIALS', '用户名或密码错误');
    }
    if (typeof password !== 'string' || password === '') {
      throw new ConsoleError('INVALID_CREDENTIALS', '用户名或密码错误');
    }
    const username = usernameRaw.trim();
    const now = this.now();
    const retryAfter = this.loginLimiter.retryAfterSeconds(ip, username, now);
    if (retryAfter > 0) {
      throw new ConsoleError('RATE_LIMITED', `登录失败次数过多，请 ${retryAfter} 秒后再试`);
    }

    const account = this.store.findAccountByUsername(username);
    const valid = account ? await verifyPassword(password, account.passwordHash) : false;
    if (!account || !valid) {
      this.loginLimiter.fail(ip, username, now);
      this.store.appendAudit({
        tenantId: account?.tenantId ?? this.config.tenantId,
        actorType: 'account',
        actorId: account?.id ?? null,
        actorName: username,
        action: 'auth.login',
        targetType: 'account',
        targetId: account?.id ?? null,
        result: 'failure',
        errorCode: 'INVALID_CREDENTIALS',
        ip: maskIp(ip),
        sandbox: false,
      });
      throw new ConsoleError('INVALID_CREDENTIALS', '用户名或密码错误');
    }
    if (account.status !== 'active' || account.deletedAt !== undefined) {
      this.store.appendAudit({
        tenantId: account.tenantId ?? this.config.tenantId,
        actorType: account.role === 'platform' ? 'platform' : 'account',
        actorId: account.id,
        actorName: account.displayName,
        action: 'auth.login',
        targetType: 'account',
        targetId: account.id,
        result: 'failure',
        errorCode: 'ACCOUNT_DISABLED',
        ip: maskIp(ip),
        sandbox: false,
      });
      throw new ConsoleError('ACCOUNT_DISABLED', '账号已停用');
    }

    this.loginLimiter.reset(ip, username);
    return this.issueSession(account, ip, { method: 'password' });
  }

  /**
   * #181 扫码登录：企微只证明「是谁」，账号与角色仍由这里决定。
   * 不自动建号；可见范围内但未绑定账号 → 403，管理员在账号页预先绑定 wecomUserId。
   */
  async loginWithWecom(
    wecomUserId: string,
    ip: string,
  ): Promise<{ account: AccountRecord; tenant: TenantRecord | null; token: string; session: SessionRecord }> {
    const account = this.store
      .listAccounts()
      .find(
        (item) =>
          item.tenantId === this.config.tenantId &&
          item.deletedAt === undefined &&
          item.wecomUserId === wecomUserId,
      );
    if (!account) {
      this.store.appendAudit({
        tenantId: this.config.tenantId,
        actorType: 'account',
        actorId: null,
        actorName: wecomActorName(wecomUserId),
        action: 'auth.login',
        targetType: 'account',
        targetId: null,
        result: 'failure',
        errorCode: 'NOT_BOUND',
        detail: { method: 'wecom' },
        ip: maskIp(ip),
        sandbox: false,
      });
      throw new ConsoleError('FORBIDDEN', '未开通控制台权限，请联系管理员');
    }
    if (account.status !== 'active') {
      this.store.appendAudit({
        tenantId: this.config.tenantId,
        actorType: 'account',
        actorId: account.id,
        actorName: account.displayName,
        action: 'auth.login',
        targetType: 'account',
        targetId: account.id,
        result: 'failure',
        errorCode: 'ACCOUNT_DISABLED',
        detail: { method: 'wecom' },
        ip: maskIp(ip),
        sandbox: false,
      });
      throw new ConsoleError('ACCOUNT_DISABLED', '账号已停用，请联系管理员');
    }
    this.loginLimiter.reset(ip, account.username);
    return this.issueSession(account, ip, {
      method: 'wecom',
      wecomUserId,
      ttlMs: this.config.wecom?.sessionTtlMs ?? WECOM_SESSION_TTL_MS,
    });
  }

  /** 密码登录与扫码登录共用同一出口：签发会话 + 审计 */
  private issueSession(
    account: AccountRecord,
    ip: string,
    options: { method: 'password' | 'wecom'; ttlMs?: number; wecomUserId?: string },
  ): { account: AccountRecord; tenant: TenantRecord | null; token: string; session: SessionRecord } {
    const now = this.now();
    const updated: AccountRecord = { ...account, lastLoginAt: now, updatedAt: now };
    this.store.saveAccount(updated);

    const token = newSessionToken();
    const session: SessionRecord = {
      tokenHash: hashToken(token),
      accountId: account.id,
      createdAt: now,
      expiresAt: now + (options.ttlMs ?? (this.config.sessionTtlMs || SESSION_TTL_MS)),
      lastSeenAt: now,
      method: options.method,
      ...(options.wecomUserId ? { wecomUserId: options.wecomUserId } : {}),
      ...(options.method === 'wecom' ? { recheckedAt: now } : {}),
    };
    this.store.saveSession(session);
    this.store.appendAudit({
      tenantId: account.tenantId ?? this.config.tenantId,
      actorType: account.role === 'platform' ? 'platform' : 'account',
      actorId: account.id,
      actorName: account.displayName,
      action: 'auth.login',
      targetType: 'account',
      targetId: account.id,
      result: 'success',
      ...(options.method === 'wecom' ? { detail: { method: 'wecom' } } : {}),
      ip: maskIp(ip),
      sandbox: false,
    });
    return {
      account: updated,
      tenant: account.tenantId ? this.store.getTenant(account.tenantId) ?? null : null,
      token,
      session,
    };
  }

  /** 从 Cookie 解析当前会话；Provider 不可用 / 过期 / 账号停用一律视为未登录 */
  resolve(req: HttpRequestLike): AuthActor | undefined {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return undefined;
    const tokenHash = hashToken(token);
    const session = this.store.getSession(tokenHash);
    if (!session) return undefined;
    const now = this.now();
    if (session.expiresAt <= now) {
      this.store.deleteSession(tokenHash);
      return undefined;
    }
    const account = this.store.getAccount(session.accountId);
    if (!account || account.status !== 'active' || account.deletedAt !== undefined) return undefined;
    if (now - session.lastSeenAt > 60_000) {
      this.store.saveSession({ ...session, lastSeenAt: now });
    }
    const tenant = account.tenantId ? this.store.getTenant(account.tenantId) ?? null : null;
    if (account.role !== 'platform' && (!tenant || tenant.id !== this.config.tenantId)) {
      return undefined;
    }
    return { account, tenant, tokenHash };
  }

  logout(tokenHash: string, actor: AuthActor): void {
    this.store.deleteSession(tokenHash);
    this.store.appendAudit({
      tenantId: actor.tenant?.id ?? this.config.tenantId,
      actorType: actor.account.role === 'platform' ? 'platform' : 'account',
      actorId: actor.account.id,
      actorName: actor.account.displayName,
      action: 'auth.logout',
      targetType: 'account',
      targetId: actor.account.id,
      result: 'success',
      sandbox: false,
    });
  }

  async changePassword(actor: AuthActor, current: unknown, next: unknown): Promise<void> {
    if (typeof current !== 'string' || !(await verifyPassword(current, actor.account.passwordHash))) {
      throw new ConsoleError('VALIDATION_FAILED', '当前密码不正确');
    }
    const issue = validatePassword(next);
    if (issue) throw new ConsoleError('VALIDATION_FAILED', issue, [{ field: 'newPassword', issue }]);
    if (current === next) {
      throw new ConsoleError('VALIDATION_FAILED', '新密码不能与当前密码相同');
    }
    const hash = await hashPassword(next as string);
    const now = this.now();
    const updated: AccountRecord = { ...actor.account, passwordHash: hash, updatedAt: now };
    this.store.saveAccount(updated);
    // 改密后让其它设备上的会话失效，保留当前会话
    for (const session of this.store.listSessions()) {
      if (session.accountId === actor.account.id && session.tokenHash !== actor.tokenHash) {
        this.store.deleteSession(session.tokenHash);
      }
    }
    this.store.appendAudit({
      tenantId: actor.tenant?.id ?? this.config.tenantId,
      actorType: actor.account.role === 'platform' ? 'platform' : 'account',
      actorId: actor.account.id,
      actorName: actor.account.displayName,
      action: 'account.password',
      targetType: 'account',
      targetId: actor.account.id,
      result: 'success',
      sandbox: false,
    });
  }

  can(account: AccountRecord, permission: string): boolean {
    return permissionsFor(account.role).includes(permission as never) || account.role === 'admin';
  }

  // ---------- 账号管理（#41） ----------

  listAccounts(
    query: { role?: string; status?: string; includeDeleted?: boolean } = {},
  ): PublicAccount[] {
    return this.store
      .listAccounts()
      .filter((account) => account.role !== 'platform')
      .filter((account) => account.tenantId === this.config.tenantId)
      .filter((account) => (query.includeDeleted === true ? true : account.deletedAt === undefined))
      .filter((account) => (query.role ? account.role === query.role : true))
      .filter((account) => (query.status ? account.status === query.status : true))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(publicAccount);
  }

  private tenantAccount(id: string): AccountRecord {
    const account = this.store.getAccount(id);
    if (
      !account ||
      account.role === 'platform' ||
      account.tenantId !== this.config.tenantId ||
      account.deletedAt !== undefined
    ) {
      throw new ConsoleError('NOT_FOUND', `账号 ${id} 不存在`);
    }
    return account;
  }

  private assertUsernameFree(username: string): void {
    const exists = this.store
      .listAccounts()
      .some((account) => account.username.toLowerCase() === username.toLowerCase());
    if (exists) throw new ConsoleError('CONFLICT', '用户名已存在');
  }

  /** 一个企微成员只能绑一个账号，避免一位员工两个身份（#181） */
  private assertWecomUserIdFree(wecomUserId: string, exceptId: string | null): void {
    const taken = this.store
      .listAccounts()
      .some(
        (account) =>
          account.wecomUserId === wecomUserId &&
          account.id !== exceptId &&
          account.deletedAt === undefined,
      );
    if (taken) throw new ConsoleError('CONFLICT', '该企微成员已绑定其他账号');
  }

  private auditAccount(
    actor: AuthActor,
    action: string,
    targetId: string | null,
    detail?: Record<string, unknown>,
  ): void {
    this.store.appendAudit({
      tenantId: this.config.tenantId,
      actorType: actor.account.role === 'platform' ? 'platform' : 'account',
      actorId: actor.account.id,
      actorName: actor.account.displayName,
      action,
      targetType: 'account',
      targetId,
      result: 'success',
      detail,
      sandbox: false,
    });
  }

  /**
   * 扫码绑定（#183）：把扫码换出的 userid 绑到发起绑定的那个账号上。
   * 调用方必须先校验 state 里的会话仍然有效（见 WecomLoginService.assertBindSession）。
   */
  bindWecom(accountId: string, rawUserid: string): PublicAccount {
    const wecomUserId = parseWecomUserId(rawUserid);
    if (!wecomUserId) {
      throw new ConsoleError('VALIDATION_FAILED', '企微身份无效，请重新扫码', [
        { field: 'wecomUserId', issue: 'invalid wecomUserId' },
      ]);
    }
    const account = this.store.getAccount(accountId);
    if (!account || account.deletedAt !== undefined) {
      throw new ConsoleError('UNAUTHORIZED', '未登录或会话已过期');
    }
    if (account.status !== 'active') {
      throw new ConsoleError('ACCOUNT_DISABLED', '控制台账号已停用，请联系管理员');
    }
    this.assertWecomUserIdFree(wecomUserId, account.id);
    const updated: AccountRecord = {
      ...account,
      wecomUserId,
      updatedAt: this.now(),
    };
    this.store.saveAccount(updated);
    this.store.appendAudit({
      tenantId: this.config.tenantId,
      actorType: 'account',
      actorId: account.id,
      actorName: wecomActorName(wecomUserId),
      action: 'account.wecom_bind',
      targetType: 'account',
      targetId: account.id,
      result: 'success',
      detail: { method: 'scan' },
      sandbox: false,
    });
    return publicAccount(updated);
  }

  async createAccount(
    actor: AuthActor,
    input: Record<string, unknown>,
  ): Promise<PublicAccount> {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
      throw new ConsoleError('VALIDATION_FAILED', '用户名需为 3–64 位字母、数字、点、下划线或连字符', [
        { field: 'username', issue: 'invalid username' },
      ]);
    }
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (displayName === '' || displayName.length > 40) {
      throw new ConsoleError('VALIDATION_FAILED', '显示名需为 1–40 字', [
        { field: 'displayName', issue: '1-40 chars' },
      ]);
    }
    const role = input.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'viewer') {
      throw new ConsoleError('VALIDATION_FAILED', '角色只能是 admin / supervisor / viewer', [
        { field: 'role', issue: 'invalid role' },
      ]);
    }
    const issue = validatePassword(input.password);
    if (issue) {
      throw new ConsoleError('VALIDATION_FAILED', issue, [{ field: 'password', issue }]);
    }
    const wecomUserId = parseWecomUserId(input.wecomUserId);
    if (wecomUserId) this.assertWecomUserIdFree(wecomUserId, null);
    const initialH5 =
      input.h5Permissions === undefined ? undefined : parseH5Permissions(input.h5Permissions);
    this.assertUsernameFree(username);

    const now = this.now();
    const account: AccountRecord = {
      id: this.store.newId('acc'),
      tenantId: this.config.tenantId,
      username,
      displayName,
      role,
      status: 'active',
      passwordHash: await hashPassword(input.password as string),
      ...(wecomUserId ? { wecomUserId } : {}),
      ...(initialH5 && initialH5.length > 0 ? { h5Permissions: initialH5 } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveAccount(account);
    this.auditAccount(actor, 'account.create', account.id, {
      role,
      ...(wecomUserId ? { wecomUserId: true } : {}),
      ...(initialH5 ? { h5Permissions: initialH5 } : {}),
    });
    return publicAccount(account);
  }

  updateAccount(
    actor: AuthActor,
    id: string,
    input: Record<string, unknown>,
  ): PublicAccount {
    const account = this.tenantAccount(id);
    const isSelf = account.id === actor.account.id;
    const patch: Partial<Pick<AccountRecord, 'displayName' | 'role' | 'status'>> = {};

    if (input.displayName !== undefined) {
      const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
      if (displayName === '' || displayName.length > 40) {
        throw new ConsoleError('VALIDATION_FAILED', '显示名需为 1–40 字', [
          { field: 'displayName', issue: '1-40 chars' },
        ]);
      }
      patch.displayName = displayName;
    }
    if (input.role !== undefined) {
      if (input.role !== 'admin' && input.role !== 'supervisor' && input.role !== 'viewer') {
        throw new ConsoleError('VALIDATION_FAILED', '角色只能是 admin / supervisor / viewer', [
          { field: 'role', issue: 'invalid role' },
        ]);
      }
      patch.role = input.role as Role;
    }
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'disabled') {
        throw new ConsoleError('VALIDATION_FAILED', 'status 只能是 active / disabled', [
          { field: 'status', issue: 'invalid status' },
        ]);
      }
      patch.status = input.status as AccountStatus;
    }
    if (isSelf && (patch.status === 'disabled' || (patch.role && patch.role !== account.role))) {
      throw new ConsoleError('CONFLICT', '不能停用或降级自己');
    }
    // 患者端 H5 能力：传数组即「设为这些」，空数组表示全部收回；不传不改
    let h5Permissions: string[] | undefined;
    if (input.h5Permissions !== undefined) {
      h5Permissions = parseH5Permissions(input.h5Permissions);
    }
    // wecomUserId 传 null / 空串表示解绑；不传表示不改
    let wecomBinding: { set: string } | { clear: true } | undefined;
    if (input.wecomUserId !== undefined) {
      const next = parseWecomUserId(input.wecomUserId);
      if (!next) {
        wecomBinding = { clear: true };
      } else {
        this.assertWecomUserIdFree(next, account.id);
        wecomBinding = { set: next };
      }
    }

    const now = this.now();
    const updated: AccountRecord = { ...account, ...patch, updatedAt: now };
    if (wecomBinding) {
      if ('clear' in wecomBinding) delete updated.wecomUserId;
      else updated.wecomUserId = wecomBinding.set;
    }
    if (h5Permissions !== undefined) {
      if (h5Permissions.length === 0) delete updated.h5Permissions;
      else updated.h5Permissions = h5Permissions;
    }
    this.store.saveAccount(updated);
    if (!isSelf && (patch.status === 'disabled' || patch.role !== undefined)) {
      this.revokeSessions(account.id);
    }
    this.auditAccount(actor, 'account.update', account.id, {
      fields: [
        ...Object.keys(patch),
        ...(wecomBinding ? ['wecomUserId'] : []),
        ...(h5Permissions !== undefined ? ['h5Permissions'] : []),
      ],
      ...(h5Permissions !== undefined ? { h5Permissions } : {}),
    });
    return publicAccount(updated);
  }

  async resetPassword(
    actor: AuthActor,
    id: string,
    newPassword: unknown,
  ): Promise<void> {
    const account = this.tenantAccount(id);
    const issue = validatePassword(newPassword);
    if (issue) {
      throw new ConsoleError('VALIDATION_FAILED', issue, [{ field: 'newPassword', issue }]);
    }
    const now = this.now();
    this.store.saveAccount({
      ...account,
      passwordHash: await hashPassword(newPassword as string),
      updatedAt: now,
    });
    this.revokeSessions(account.id);
    this.auditAccount(actor, 'account.reset_password', account.id);
  }

  deleteAccount(actor: AuthActor, id: string): void {
    const account = this.tenantAccount(id);
    if (account.id === actor.account.id) {
      throw new ConsoleError('CONFLICT', '不能删除自己');
    }
    const now = this.now();
    this.store.saveAccount({ ...account, deletedAt: now, updatedAt: now });
    this.revokeSessions(account.id);
    this.auditAccount(actor, 'account.delete', account.id);
  }

  private revokeSessions(accountId: string): void {
    for (const session of this.store.listSessions()) {
      if (session.accountId === accountId) this.store.deleteSession(session.tokenHash);
    }
  }

  sessionView(actor: AuthActor): {
    account: { id: string; displayName: string; role: Role };
    tenant: {
      id: string;
      name: string;
      agentName: string;
      patientTerm: string;
      agentAvatar: string | null;
      tone: string;
      timezone: string;
    } | null;
    permissions: string[];
    serverTime: number;
  } {
    const tenant = actor.tenant;
    return {
      account: {
        id: actor.account.id,
        displayName: actor.account.displayName,
        role: actor.account.role,
      },
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            agentName: tenant.agentName,
            patientTerm: tenant.patientTerm,
            agentAvatar: tenant.agentAvatar,
            tone: tenant.tone,
            timezone: tenant.timezone,
          }
        : null,
      permissions: permissionsFor(actor.account.role),
      serverTime: this.now(),
    };
  }

  requestIp(req: HttpRequestLike): string {
    const forwarded = header(req, 'x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]!.trim();
    return req.socket?.remoteAddress ?? '127.0.0.1';
  }

  emitEvent(type: string, data: unknown): void {
    this.emit(type, data);
  }
}
